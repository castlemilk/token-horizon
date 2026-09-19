import Foundation

/// How token usage is measured. Swappable per settings
/// (`SettingsStore.meterCaptureMode`, env `TH_CAPTURE_MODE`):
///
/// - `point`: tools are explicitly configured at loopback request meters
///   (RequestMeter relays; `ANTHROPIC_BASE_URL` etc.). The default, and the
///   only mode suitable for CORPORATE machines: nothing is intercepted,
///   every measured byte was deliberately routed by the user.
/// - `mitm`: a scoped local proxy intercepts TLS for AI VENDOR HOSTS ONLY
///   (MitmCaptureManager + MitmAddonScript). For PERSONAL machines whose
///   users want zero-config coverage of hardcoded-endpoint apps (desktop
///   clients, IDEs). Requires the dedicated `.mitm` consent — never
///   auto-granted, headless never grants (TH_CONSENT=mitm only).
/// Capture methodology — the operator's single knob for the usage source.
///
/// - point: loopback request meters count usage (default; corporate-safe).
/// - mitm: scoped TLS interception of AI vendor hosts counts usage
///   (personal machines, explicit .mitm consent).
/// - files: provider session FILES count usage (selfReported rows via
///   scheduled backfill) — no meters, no interception.
///
/// point and mitm ALWAYS run file annotation (files contribute tool labels,
/// reported cost and limit snapshots — never usage rows). files mode still
/// annotates, and additionally makes the scanners the counting source.
public enum MeterCaptureMode: String, Codable, CaseIterable {
    case point
    case mitm
    case files
}

/// The capture-mode seam: one active implementation per host, selected from
/// settings and swappable at runtime. Both modes emit the SAME UsageEvents
/// into the SAME store — downstream (analytics, sync, UI) is mode-agnostic.
public protocol MeterCapturing: AnyObject {
    var mode: MeterCaptureMode { get }
    /// Structured status for GET /meters (liveness + setup checklist).
    var status: [String: Any] { get }
    func start()
    func stop()
}
