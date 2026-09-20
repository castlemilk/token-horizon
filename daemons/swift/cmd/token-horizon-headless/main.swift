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

// First: a cancelled client mid-stream must never SIGPIPE the daemon.
ignoreSIGPIPE()

#if os(Linux)
Platform.systemStats = ProcFSSystemStats.self
#endif

// Service management — runs WITHOUT starting the daemon (installers, the UI
// settings toggle, and operators use these):
//   token-horizon-headless --service-status | --install-service | --uninstall-service
// All print the resulting AutoStartStatus JSON; exit non-zero on failure.
if CommandLine.arguments.count > 1 {
    func printStatus(_ s: AutoStartStatus) {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? enc.encode(s), let str = String(data: data, encoding: .utf8) {
            print(str)
        }
    }
    switch CommandLine.arguments[1] {
    case "--service-status":
        printStatus(DaemonAutoStart.status())
        exit(0)
    case "--install-service":
        do { printStatus(try DaemonAutoStart.install()); exit(0) }
        catch {
            FileHandle.standardError.write("install-service failed: \(error)\n".data(using: .utf8)!)
            printStatus(DaemonAutoStart.status())
            exit(1)
        }
    case "--uninstall-service":
        do { printStatus(try DaemonAutoStart.uninstall()); exit(0) }
        catch {
            FileHandle.standardError.write("uninstall-service failed: \(error)\n".data(using: .utf8)!)
            printStatus(DaemonAutoStart.status())
            exit(1)
        }
    default:
        break
    }
}

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
    if SettingsStore.shared.meterCaptureMode == .files {
        _ = ConsentManager.shared.ensure(.fileReading,
            reason: "Provider session files (codex, claude, opencode, kimi) are scanned continuously and become the usage counting source (self-reported rows). No meters run in this mode.")
    }
}

// Provider-parity usage for self-managed runtimes via the durable ledger.
engine.localRuntimeUsage = { RuntimeUsageLedger.shared.contributions() }
InferenceMonitor.shared.startPolling()
// Routine file polling → tool attribution + limit observations on the DB
// timeline (requires .fileReading consent; TH_CONSENT=fileReading to opt in
// headless). Files never create usage rows — usage is metered-only.
// timeline (requires .fileReading consent; TH_CONSENT=fileReading to opt in
// headless). Files never create usage rows — usage is metered-only.
// Consolidation is MANUAL by default (POST /consolidate); continuous polling
// is opt-in via Settings.filePolling / TH_FILE_POLL=1.
if ConsentManager.shared.isGranted(.fileReading), SettingsStore.shared.filePolling {
    FilePoller.shared.startPolling()
}

// Capture mode (point meters ↔ scoped mitm, per settings/TH_CAPTURE_MODE).
// Consent is enforced per mode inside startCaptureMode.
router.startCaptureMode()

// Cloud sync outbox (TH_SYNC_URL): retry pending deltas every 5 min so
// offline stretches (flights) upload on reconnect. Manual: POST /sync/now.
// A UI sign-in persisted to cloud-identity.json overrides the env identity
// (and supplies the base URL when TH_SYNC_URL is unset) so background sync
// attributes to the signed-in user with the UI closed.
if let identity = CloudIdentityStore.load() {
    CloudIdentityStore.apply(identity, to: CloudSync.shared)
}
var cloudSyncTimer: DispatchSourceTimer?
if CloudSync.shared.baseURL != nil, let store = usageStore {
    CloudSync.shared.attach(store: store)   // lets event ingestion nudge syncs
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

// Warm the limits cache at startup (fire-and-forget on the utility queue)
// so the first GET /limits already has rows instead of an empty cold cache.
PlanLimitsEngine.shared.refreshIfDue()
KimiLimitsEngine.shared.refreshIfDue()

let server = POSIXLoopbackHTTPServer { router.route($0) }
server.start()
guard server.port > 0 else {
    FileHandle.standardError.write(Data("token-horizon-headless: could not bind 127.0.0.1:8765-8784\n".utf8))
    exit(1)
}
print("token-horizon-headless listening on http://127.0.0.1:\(server.port)")
dispatchMain()
