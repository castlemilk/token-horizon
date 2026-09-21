package vendors

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/castlemilk/token-horizon/daemons/go/internal/providers/auth"
	"github.com/castlemilk/token-horizon/daemons/go/internal/providers/limits"
)

// ---- Gemini (CloudCode + Antigravity language server) ----

type Gemini struct{ LsofPath string } // LsofPath overrides agy discovery (tests)

func (Gemini) Provider() string { return "google" }

var geminiCredsPath = func() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".gemini/oauth_creds.json")
}

func (g Gemini) chain() auth.Chain {
	return auth.Chain{Sources: []auth.Source{
		auth.FileJSON(geminiCredsPath(), "access_token"),
		auth.KeychainBase64JSON("gemini", "antigravity", "access_token"),
	}}
}

func (g Gemini) HasCredentials() bool { return g.chain().Resolve() != "" }

func (g Gemini) credentials() []auth.LabeledCredential {
	home, _ := os.UserHomeDir()
	var dirs []string
	entries, _ := os.ReadDir(home)
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), ".gemini") {
			dirs = append(dirs, filepath.Join(home, e.Name()))
		}
	}
	if len(dirs) == 0 {
		dirs = []string{filepath.Join(home, ".gemini")}
	}
	var out []auth.LabeledCredential
	for _, dir := range dirs {
		data, err := os.ReadFile(filepath.Join(dir, "oauth_creds.json"))
		if err != nil {
			continue
		}
		var obj map[string]any
		if json.Unmarshal(data, &obj) != nil {
			continue
		}
		if token, _ := obj["access_token"].(string); token != "" {
			label := ""
			if len(dirs) > 1 {
				label = strings.TrimPrefix(filepath.Base(dir), ".")
			}
			out = append(out, auth.LabeledCredential{Label: label, Credential: token})
		}
	}
	if len(out) == 0 {
		if token := g.chain().Resolve(); token != "" {
			out = append(out, auth.LabeledCredential{Credential: token})
		}
	}
	return out
}

func (g Gemini) Fetch() []limits.Limit {
	if agy := g.fetchAgyLanguageServerLimits(); len(agy) > 0 {
		return agy
	}
	creds := g.credentials()
	if len(creds) == 0 {
		return nil
	}
	var out []limits.Limit
	for i, cred := range creds {
		if i > 0 {
			time.Sleep(100 * time.Millisecond)
		}
		out = append(out, g.fetchCloudCode(cred.Credential)...)
	}
	return out
}

func (g Gemini) projectID() string {
	data, err := os.ReadFile(geminiCredsPath())
	if err != nil {
		return ""
	}
	var obj map[string]any
	if json.Unmarshal(data, &obj) != nil {
		return ""
	}
	id, _ := obj["project_id"].(string)
	return id
}

func (g Gemini) fetchCloudCode(token string) []limits.Limit {
	obj := limits.PostJSON("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
		token, "google", map[string]any{"project": g.projectID()})
	buckets, _ := obj["buckets"].([]any)
	var out []limits.Limit
	for _, raw := range buckets {
		bucket, _ := raw.(map[string]any)
		remaining, ok := limits.Number(bucket["remainingFraction"])
		if !ok {
			continue
		}
		used := (1 - remaining) * 100
		model, _ := bucket["modelId"].(string)
		if model == "" {
			model, _ = bucket["tokenType"].(string)
		}
		if model == "" {
			model = "gemini"
		}
		reset, _ := bucket["resetTime"].(string)
		out = append(out, limits.Clamped("gemini", model, used, limits.ISOUnix(reset), "", ""))
	}
	return out
}

// Antigravity (agy) language server on loopback: discover listen ports via
// lsof, POST RetrieveUserQuotaSummary.
var agyPortRe = regexp.MustCompile(`127\.0\.0\.1:(\d+)`)

func (g Gemini) discoverAgyPorts() []int {
	lsof := g.LsofPath
	if lsof == "" {
		lsof = "lsof"
	}
	out, err := limits.ExecCommand(lsof, "-nP", "-iTCP", "-sTCP:LISTEN", "-c", "agy", "-a", "-i4")
	if err != nil {
		return nil
	}
	var ports []int
	seen := map[int]bool{}
	for _, m := range agyPortRe.FindAllStringSubmatch(out, -1) {
		var p int
		fmt.Sscanf(m[1], "%d", &p)
		if p > 0 && !seen[p] {
			seen[p] = true
			ports = append(ports, p)
		}
	}
	return ports
}

func (g Gemini) fetchAgyLanguageServerLimits() []limits.Limit {
	for _, port := range g.discoverAgyPorts() {
		req, err := http.NewRequest(http.MethodPost,
			fmt.Sprintf("http://127.0.0.1:%d/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary", port),
			strings.NewReader("{}"))
		if err != nil {
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		data := limits.PerformRaw(req, "agy")
		if data == nil {
			continue
		}
		var obj map[string]any
		if json.Unmarshal(data, &obj) != nil {
			continue
		}
		resp, _ := obj["response"].(map[string]any)
		groups, _ := resp["groups"].([]any)
		if len(groups) == 0 {
			continue
		}
		var out []limits.Limit
		for _, rawG := range groups {
			gr, _ := rawG.(map[string]any)
			gname, _ := gr["displayName"].(string)
			lower := strings.ToLower(gname)
			prefix := lower
			if strings.Contains(lower, "gemini") {
				prefix = "gemini"
			} else if strings.Contains(lower, "claude") || strings.Contains(lower, "gpt") {
				prefix = "3p"
			}
			buckets, _ := gr["buckets"].([]any)
			for _, rawB := range buckets {
				b, _ := rawB.(map[string]any)
				rem := numOr(b["remainingFraction"], 1.0)
				used := (1.0 - rem) * 100.0
				if used < 0 {
					used = 0
				}
				if used > 100 {
					used = 100
				}
				window, _ := b["window"].(string)
				if window == "" {
					window, _ = b["bucketId"].(string)
				}
				if window == "" {
					window = "quota"
				}
				reset, _ := b["resetTime"].(string)
				out = append(out, limits.Clamped("agy", prefix+" "+window,
					float64(int(used*10+0.5))/10, limits.ISOUnix(reset),
					fmt.Sprintf("%d%% left", int(rem*100+0.5)), ""))
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	return nil
}
