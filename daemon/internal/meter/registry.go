package meter

// Registry: vendor → wire format / default target / deterministic port, and
// the startup wiring (TH_METERS env + settings toggles), gated on the
// capture methodology (files mode = no meters) and .metering consent.
// Ported from Providers/Meterable.swift (MeterRegistry) + the per-vendor
// meterTarget declarations.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/castlemilk/token-horizon/daemon/internal/core"
)

// vendorSpec describes one meterable vendor.
type vendorSpec struct {
	format func() Format
	target string // default upstream API base
	port   int    // deterministic default listen port
	source string // "external" | "selfManaged"
}

var vendorSpecs = map[string]vendorSpec{
	"claude":   {anthropic, "https://api.anthropic.com", 9241, "external"},
	"openai":   {openai, "https://api.openai.com", 9242, "external"},
	"codex":    {openai, "https://api.openai.com", 9243, "external"},
	"glm":      {openai, "https://open.bigmodel.cn", 9244, "external"},
	"opencode": {openai, "https://opencode.ai", 9245, "external"},
	"kimi":     {anthropic, "https://api.kimi.com", 9246, "external"},
	"minimax":  {openai, "https://api.minimax.io", 9247, "external"},
	"alibaba":  {openai, "https://dashscope.aliyuncs.com", 9248, "external"},
	"deepseek": {openai, "https://api.deepseek.com", 9249, "external"},
	"gemini":   {gemini, "https://generativelanguage.googleapis.com", 9250, "external"},
	// Self-managed runtimes: deterministic auto-meter ports (no default
	// target — the runtime's own endpoint is supplied by the monitor).
	"ollama":   {ollama, "", 11435, "selfManaged"},
	"vllm":     {openai, "", 9311, "selfManaged"},
	"sglang":   {openai, "", 9312, "selfManaged"},
	"llamacpp": {openai, "", 9313, "selfManaged"},
	"mlx":      {openai, "", 9314, "selfManaged"},
}

func anthropic() Format { return anthropicFormat{} }
func openai() Format    { return openAIFormat{} }
func gemini() Format    { return geminiFormat{} }
func ollama() Format    { return ollamaFormat{} }

// Canonical alias map (google ↔ gemini).
var aliases = map[string]string{"google": "gemini", "gemini": "google"}

// DefaultListenPort: stable across restarts so UI toggles, docs and muscle
// memory agree. Unknown vendors hash into 9260-9299 (djb2, same as Swift).
func DefaultListenPort(vendor string) int {
	key := strings.ToLower(strings.TrimSpace(vendor))
	if spec, ok := vendorSpecs[key]; ok {
		return spec.port
	}
	var h uint32 = 5381
	for _, c := range []byte(key) {
		h = h*33 + uint32(c)
	}
	return 9260 + int(h%40)
}

// Registry tracks live meters.
type Registry struct {
	mu     sync.Mutex
	meters []*Meter
	store  Storer
	nudge  func()
}

func NewRegistry(store Storer, nudge func()) *Registry {
	return &Registry{store: store, nudge: nudge}
}

// Add starts a meter for vendor on port, relaying to target (nil = vendor
// default). Refuses in files methodology (the scanners are the counting
// source — a meter would double count), without consent, or on a port
// conflict. Mirrors CoreAPIRouter.addMeter.
func (r *Registry) Add(vendor string, port int, target string, product string) bool {
	if core.LoadSettings().Methodology() == core.MethodologyFiles {
		return false
	}
	if !core.ConsentGranted("metering") {
		return false
	}
	key := strings.ToLower(strings.TrimSpace(vendor))
	spec, ok := vendorSpecs[key]
	if !ok {
		// Unknown vendor: OpenAI-compatible is the safest default parser.
		spec = vendorSpec{format: openai, source: "external"}
	}
	if target == "" {
		target = spec.target
	}
	if target == "" {
		return false // no upstream to relay to
	}
	if port == 0 {
		port = DefaultListenPort(key)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, m := range r.meters {
		if m.ListenPort == port {
			return false
		}
	}
	m := &Meter{
		Vendor: key, ListenPort: port, TargetBase: target,
		Source: spec.source, Store: r.store, Format: spec.format(),
		ProductLabel: product, Nudge: r.nudge,
	}
	if err := m.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "token-horizon: meter %s on 127.0.0.1:%d failed: %v\n", key, port, err)
		return false
	}
	r.meters = append(r.meters, m)
	fmt.Fprintf(os.Stderr, "token-horizon: meter %s listening on 127.0.0.1:%d → %s\n", key, port, target)
	return true
}

// EnsureVendor: runtime-monitor auto-metering hook — start the vendor's
// default-spec meter (deterministic port) if not already running. Fires on
// every sighting; Add is idempotent per port, so consent granted later or a
// failed bind is retried on the next sighting.
func (r *Registry) EnsureVendor(vendor string) {
	key := strings.ToLower(strings.TrimSpace(vendor))
	spec, ok := vendorSpecs[key]
	if !ok {
		return
	}
	target := spec.target
	if target == "" {
		target = firstRuntimeEndpoint(key)
	}
	if target == "" {
		// Swift defaultMeterTarget parity: configured endpoints first, then
		// the runtime's own default loopback port.
		if port := runtimeDefaultPorts[key]; port != 0 {
			target = "http://127.0.0.1:" + strconv.Itoa(port)
		}
	}
	if target == "" {
		return
	}
	r.Add(key, spec.port, target, "")
}

// runtimeDefaultPorts: each self-managed runtime's own server port (meter
// upstream fallback when no endpoint is configured).
var runtimeDefaultPorts = map[string]int{
	"ollama": 11434, "vllm": 8000, "sglang": 30000, "llamacpp": 8080, "mlx": 8081,
}

// firstRuntimeEndpoint: settings.runtimeEndpoints[vendor][0].url.
func firstRuntimeEndpoint(vendor string) string {
	home, _ := os.UserHomeDir()
	configDir := os.Getenv("TH_CONFIG_DIR")
	if configDir == "" {
		configDir = filepath.Join(home, ".config/token-horizon")
	}
	data, err := os.ReadFile(filepath.Join(configDir, "settings.json"))
	if err != nil {
		return ""
	}
	var settings struct {
		RuntimeEndpoints map[string][]struct {
			URL string `json:"url"`
		} `json:"runtimeEndpoints"`
	}
	if json.Unmarshal(data, &settings) != nil {
		return ""
	}
	if eps := settings.RuntimeEndpoints[vendor]; len(eps) > 0 {
		return strings.TrimSuffix(eps[0].URL, "/")
	}
	return ""
}

// StartFromEnv parses TH_METERS="vendor:port[@product][->target],...".
func (r *Registry) StartFromEnv() {
	spec := os.Getenv("TH_METERS")
	if spec == "" {
		return
	}
	if !core.ConsentGranted("metering") {
		fmt.Fprintln(os.Stderr, "token-horizon: TH_METERS set but metering consent not granted; listeners disabled (TH_CONSENT=metering to grant)")
		return
	}
	for _, entry := range strings.Split(spec, ",") {
		text := strings.TrimSpace(entry)
		colon := strings.Index(text, ":")
		if colon < 0 {
			continue
		}
		vendor := strings.ToLower(strings.TrimSpace(text[:colon]))
		if vendor == "" {
			continue
		}
		rest := strings.TrimSpace(text[colon+1:])
		target := ""
		if i := strings.Index(rest, "->"); i >= 0 {
			target = strings.TrimSpace(rest[i+2:])
			rest = strings.TrimSpace(rest[:i])
			if !strings.HasPrefix(target, "http://") && !strings.HasPrefix(target, "https://") {
				continue
			}
		}
		product := ""
		if i := strings.LastIndex(rest, "@"); i >= 0 {
			product = strings.TrimSpace(rest[i+1:])
			rest = strings.TrimSpace(rest[:i])
		}
		port, err := strconv.Atoi(rest)
		if err != nil || port <= 0 || port > 65535 {
			continue
		}
		r.Add(vendor, port, target, product)
	}
}

// StartFromToggles starts meters for vendors explicitly toggled ON in
// settings (default port + default target). Toggle-off suppresses.
func (r *Registry) StartFromToggles() {
	for vendor, on := range core.LoadSettings().MeterToggles {
		if on {
			r.Add(vendor, 0, "", "")
		}
	}
}

// Status / Catalog back GET /meters.
func (r *Registry) Status() []core.MeterStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]core.MeterStatus, 0, len(r.meters))
	for _, m := range r.meters {
		out = append(out, core.MeterStatus{
			Vendor: m.Vendor, ListenPort: m.ListenPort, Target: m.TargetBase,
			Source: m.Source, Seen: m.Seen(), Measured: m.Measured(),
		})
	}
	return out
}

func (r *Registry) Catalog() []core.VendorStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	var keys []string
	for k := range vendorSpecs {
		keys = append(keys, k)
	}
	// google alias when gemini present (Swift MeterRegistry.aliases).
	for from, to := range aliases {
		found := false
		for _, k := range keys {
			if k == from {
				found = true
			}
		}
		if found {
			dup := false
			for _, k := range keys {
				if k == to {
					dup = true
				}
			}
			if !dup {
				keys = append(keys, to)
			}
		}
	}
	out := make([]core.VendorStatus, 0, len(keys))
	for _, k := range keys {
		vs := core.VendorStatus{Vendor: k}
		for _, m := range r.meters {
			if strings.EqualFold(m.Vendor, k) {
				vs.Running = true
				vs.ListenPort = m.ListenPort
				vs.Target = m.TargetBase
			}
		}
		out = append(out, vs)
	}
	return out
}

// RoutedURL: the loopback URL of the meter forwarding to endpoint, if one
// is live. THE routing rule for internal clients — consult before calling
// any runtime/vendor endpoint so all measured traffic uses one path.
func (r *Registry) RoutedURL(endpoint string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, m := range r.meters {
		if sameEndpoint(m.TargetBase, endpoint) {
			return fmt.Sprintf("http://127.0.0.1:%d", m.ListenPort)
		}
	}
	return ""
}

// sameEndpoint: scheme + host + effective port (default 80/443).
func sameEndpoint(a, b string) bool {
	parse := func(u string) (scheme, host string, port int) {
		scheme = "http"
		if i := strings.Index(u, "://"); i >= 0 {
			scheme = u[:i]
			u = u[i+3:]
		}
		u = strings.TrimSuffix(strings.SplitN(u, "/", 2)[0], "/")
		if i := strings.LastIndex(u, ":"); i >= 0 {
			if p, err := strconv.Atoi(u[i+1:]); err == nil {
				return scheme, u[:i], p
			}
		}
		port = 80
		if scheme == "https" {
			port = 443
		}
		return scheme, u, port
	}
	s1, h1, p1 := parse(a)
	s2, h2, p2 := parse(b)
	return s1 == s2 && h1 == h2 && p1 == p2
}
