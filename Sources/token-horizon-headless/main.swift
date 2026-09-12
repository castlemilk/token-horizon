import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import TokenHorizonCore

#if os(Linux)
import Glibc
#elseif os(Windows)
import ucrt
#endif

// token-horizon-headless: the Token Horizon loopback API without the macOS app.
// All route logic lives in TokenHorizonCore's CoreAPIRouter; this host only
// wires platform seams and starts transports/engines.

#if os(Linux)
Platform.systemStats = ProcFSSystemStats.self
#endif

let engine = UsageEngine()

let usageStore: UsageStoring? = {
    do { return try SQLiteUsageStore() }
    catch {
        FileHandle.standardError.write("token-horizon-headless: usage store unavailable: \(error)\n".data(using: .utf8)!)
        return nil
    }
}()

let router = CoreAPIRouter(engine: engine, usageStore: usageStore)
engine.usageStore = usageStore   // store-backed reads (heatmap grid, etc.)
router.serverName = "token-horizon-headless"

// Consent: nothing listens without it. Interactive hosts ask via OS dialog;
// headless never auto-grants — TH_CONSENT=metering|all opts in.
if ProcessInfo.processInfo.environment["TH_ASK_CONSENT"] != nil {
    _ = ConsentManager.shared.ensure(.metering,
        reason: "Loopback request listeners measure token usage, model, thinking level, and rates per API request. Traffic is forwarded unchanged to the real API.")
    if SettingsStore.shared.meterCaptureMode == .mitm {
        _ = ConsentManager.shared.ensure(.mitm,
            reason: "A local proxy intercepts TLS for AI vendor API hosts ONLY (all other traffic passes through untouched, undecrypted) to measure token usage without per-tool configuration. Requires installing a local CA certificate. Corporate machines: use point mode instead.")
    }
}

// Provider-parity usage for self-managed runtimes via the durable ledger.
engine.localRuntimeUsage = { RuntimeUsageLedger.shared.contributions() }
InferenceMonitor.shared.startPolling()
// Routine file polling → tool attribution + limit observations on the DB
// timeline (requires .fileReading consent; TH_CONSENT=fileReading to opt in
// headless). Files never create usage rows — usage is metered-only.
if ConsentManager.shared.isGranted(.fileReading) {
    FilePoller.shared.startPolling()
}

// Capture mode (point meters ↔ scoped mitm, per settings/TH_CAPTURE_MODE).
// Consent is enforced per mode inside startCaptureMode.
router.startCaptureMode()

// Cloud sync outbox (TH_SYNC_URL): retry pending deltas every 5 min so
// offline stretches (flights) upload on reconnect. Manual: POST /sync/now.
var cloudSyncTimer: DispatchSourceTimer?
if CloudSync.shared.baseURL != nil, let store = usageStore {
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "tokenhorizon.cloudsync", qos: .utility))
    timer.schedule(deadline: .now() + 30, repeating: 300)
    timer.setEventHandler { _ = CloudSync.shared.sync(store: store) }
    timer.resume()
    cloudSyncTimer = timer
}

// Explicit opt-in only: annotation/limits backfill from logs into the store.
if ProcessInfo.processInfo.environment["TH_CONSOLIDATE"] == "1", let store = usageStore {
    _ = try? ConsolidationRunner.run(into: store)
}

let server = POSIXLoopbackHTTPServer { router.route($0) }
server.start()
guard server.port > 0 else {
    FileHandle.standardError.write(Data("token-horizon-headless: could not bind 127.0.0.1:8765-8784\n".utf8))
    exit(1)
}
print("token-horizon-headless listening on http://127.0.0.1:\(server.port)")
dispatchMain()
