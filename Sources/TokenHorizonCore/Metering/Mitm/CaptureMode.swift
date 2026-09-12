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
public enum MeterCaptureMode: String, Codable, CaseIterable {
    case point
    case mitm
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
