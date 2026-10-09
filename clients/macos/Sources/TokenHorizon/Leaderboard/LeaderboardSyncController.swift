import Combine
import Foundation

enum LeaderboardSyncBackend: Equatable {
    case cloud
    case sheets
}

/// A fresh engine read supplied by AppDelegate, away from the main queue.
/// Privacy filtering remains in LeaderboardStore.syncLocal, shared by every
/// publication path.
struct LeaderboardSyncLocalData {
    let snapshot: UsageSnapshot
    let history: [HistoryPoint]
    let streak: Int
    let heatmap: [[Int]]?
    var hourlyHistory: [LeaderboardHourlyPoint]?
}

struct LeaderboardSyncOutcome {
    let backend: LeaderboardSyncBackend?
    let rowCount: Int?
    let localData: LeaderboardSyncLocalData?
    let didPerformWork: Bool
}

/// One observable sync operation for all app surfaces. Manual cloud sync signs
/// in when needed, then stages fresh usage before publishing and refreshing
/// rankings. Auto
/// sync uses the entry already staged by the background refresh and preserves
/// the store's TTL/change policy. Callbacks are injectable so coordination is
/// tested without publishing, network requests, or settings/disk writes.
final class LeaderboardSyncController: ObservableObject {
    typealias Completion = (Result<LeaderboardSyncOutcome, Error>) -> Void
    typealias Collector = (@escaping (Result<LeaderboardSyncLocalData, Error>) -> Void) -> Void
    typealias Stager = (LeaderboardSyncLocalData, @escaping (Result<Void, Error>) -> Void) -> Void
    typealias Authorizer = (@escaping (Result<Void, Error>) -> Void) -> Void
    typealias Publisher = (LeaderboardSyncBackend, Bool, @escaping (Result<String, Error>) -> Void) -> Void
    typealias Puller = (LeaderboardSyncBackend, Bool, @escaping (Result<Int, Error>) -> Void) -> Void

    static let shared = LeaderboardSyncController()
    static let automaticFailureRetryInterval: TimeInterval = 30

    @Published private(set) var isSyncing = false
    @Published private(set) var statusText = "Ready to sync"
    @Published private(set) var lastError: String?
    @Published private(set) var lastSuccessAt: Date?

    private var collectLocal: Collector?
    private let stageLocal: Stager
    private let resolveBackend: (Bool) -> LeaderboardSyncBackend?
    private let authNeeded: () -> Bool
    private let authorize: Authorizer
    private let canPublish: (LeaderboardSyncBackend) -> Bool
    private let hasAutomaticWork: (LeaderboardSyncBackend) -> Bool
    private let publish: Publisher
    private let pull: Puller
    private let now: () -> Date
    private var activeRun: UUID?
    private var authorizingRun: UUID?
    private var authorizationAttempted = false
    private var activeIsManual = false
    private var completions: [Completion] = []
    private var pendingManual = false
    private var pendingManualCompletions: [Completion] = []
    private var lastAutomaticFailureAt: Date?

    init(
        collectLocal: Collector? = nil,
        stageLocal: @escaping Stager = { data, completion in
            DispatchQueue.global(qos: .utility).async {
                LeaderboardStore.shared.syncLocal(data)
                completion(.success(()))
            }
        },
        resolveBackend: @escaping (Bool) -> LeaderboardSyncBackend? = { forced in
            let settings = SettingsStore.shared
            return LeaderboardSyncController.backend(cloudConfigured: settings.leaderboardCloudConfigured,
                                                     sheetsURL: settings.leaderboardSheetsURL, forced: forced)
        },
        authNeeded: @escaping () -> Bool = {
            let settings = SettingsStore.shared
            guard settings.leaderboardCloudToken.isEmpty else { return false }
            let handle = CloudPublishCredentials.effectiveHandle(
                settings.leaderboardHandle.isEmpty ? NSUserName() : settings.leaderboardHandle)
            return !DesktopCloudAccountStore.shared.canPublish(baseURL: settings.leaderboardCloudURL,
                                                               handle: handle)
        },
        authorize: @escaping Authorizer = { completion in
            CloudSignInController.shared.signIn(completion: completion)
        },
        canPublish: @escaping (LeaderboardSyncBackend) -> Bool = { backend in
            backend == .cloud || LeaderboardStore.resolveGoogleSheetsURL(
                SettingsStore.shared.leaderboardSheetsURL).writeURL != nil
        },
        hasAutomaticWork: @escaping (LeaderboardSyncBackend) -> Bool = { backend in
            LeaderboardStore.shared.hasSyncWork(for: backend)
        },
        publish: @escaping Publisher = { backend, forced, completion in
            switch backend {
            case .cloud: LeaderboardStore.shared.publishToCloud(forced: forced, completion: completion)
            case .sheets: LeaderboardStore.shared.publishToGoogleSheet(forced: forced, completion: completion)
            }
        },
        pull: @escaping Puller = { backend, forced, completion in
            switch backend {
            case .cloud: LeaderboardStore.shared.pullFromCloud(forced: forced, completion: completion)
            case .sheets: LeaderboardStore.shared.pullFromGoogleSheet(forced: forced, completion: completion)
            }
        },
        now: @escaping () -> Date = Date.init
    ) {
        self.collectLocal = collectLocal
        self.stageLocal = stageLocal
        self.resolveBackend = resolveBackend
        self.authNeeded = authNeeded
        self.authorize = authorize
        self.canPublish = canPublish
        self.hasAutomaticWork = hasAutomaticWork
        self.publish = publish
        self.pull = pull
        self.now = now
    }

    /// AppDelegate supplies the real engine collector once at launch. The
    /// collector must perform engine reads off-main; callbacks may arrive on
    /// any queue and all observable state/completions are delivered on main.
    func configureCollector(_ collector: @escaping Collector) {
        onMain { self.collectLocal = collector }
    }

    func syncNow(completion: Completion? = nil) {
        onMain { self.requestSync(forced: true, completion: completion) }
    }

    func syncAutomatically(completion: Completion? = nil) {
        onMain { self.requestSync(forced: false, completion: completion) }
    }

    /// True when a cloud sync would need interactive sign-in. Background sync
    /// never opens an authentication window (see requestSync), so surfaces use
    /// this to explain a paused auto-sync instead of leaving it silently idle.
    var requiresSignIn: Bool { authNeeded() }

    /// Explicit cloud configuration wins, then the legacy Sheets source.
    /// Manual sync keeps the app's existing canonical-cloud default; merely
    /// launching or viewing a surface never enables automatic publication.
    static func backend(cloudConfigured: Bool, sheetsURL: String, forced: Bool) -> LeaderboardSyncBackend? {
        if cloudConfigured { return .cloud }
        if !sheetsURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .sheets }
        return forced ? .cloud : nil
    }

    private func requestSync(forced: Bool, completion: Completion?) {
        if activeRun != nil {
            if forced && !activeIsManual {
                // A manual click must not inherit an automatic TTL skip.
                // Queue one forced fresh read after the current operation.
                pendingManual = true
                if let completion { pendingManualCompletions.append(completion) }
            } else if let completion {
                completions.append(completion)
            }
            return
        }

        guard let backend = resolveBackend(forced) else {
            completion?(.success(LeaderboardSyncOutcome(backend: nil, rowCount: nil,
                                                       localData: nil, didPerformWork: false)))
            return
        }
        let needsSignIn = backend == .cloud && authNeeded()
        if !forced && needsSignIn {
            // Background refresh never opens an authentication window or
            // publishes anonymously. Preserve the last visible result until
            // the user explicitly starts a sync.
            completion?(.success(LeaderboardSyncOutcome(backend: backend, rowCount: nil,
                                                       localData: nil, didPerformWork: false)))
            return
        }
        guard forced || hasAutomaticWork(backend) else {
            // An idle 5s app tick must not reset the last real sync time or
            // hide an earlier failure with an invented success.
            completion?(.success(LeaderboardSyncOutcome(backend: backend, rowCount: nil,
                                                       localData: nil, didPerformWork: false)))
            return
        }
        if !forced, let failedAt = lastAutomaticFailureAt,
           now().timeIntervalSince(failedAt) < Self.automaticFailureRetryInterval {
            // Permanent auth/connection failures must not retry and flicker
            // on every 5s refresh tick. Manual sync always bypasses this.
            completion?(.success(LeaderboardSyncOutcome(backend: backend, rowCount: nil,
                                                       localData: nil, didPerformWork: false)))
            return
        }

        let run = UUID()
        activeRun = run
        authorizationAttempted = false
        activeIsManual = forced
        completions = completion.map { [$0] } ?? []
        isSyncing = true
        lastError = nil
        if forced && needsSignIn {
            authorizeThenRefresh(run: run, backend: backend)
        } else if forced {
            refreshLocalThenPublish(run: run, backend: backend)
        } else {
            publishThenPull(run: run, backend: backend, forced: false, data: nil)
        }
    }

    private func authorizeThenRefresh(run: UUID, backend: LeaderboardSyncBackend) {
        guard activeRun == run, !authorizationAttempted else { return }
        // A stale legacy token and a newly rejected desktop grant can both
        // need sign-in. One consent attempt per run prevents an auth loop.
        authorizationAttempted = true
        statusText = "Sign in to sync"
        authorizingRun = run
        authorize { [weak self] result in
            self?.onMain {
                guard let self, self.activeRun == run, self.authorizingRun == run else { return }
                self.authorizingRun = nil
                switch result {
                case .success:
                    // Browser consent may select a different handle. Stage a
                    // fresh local entry using the newly saved identity.
                    self.refreshLocalThenPublish(run: run, backend: backend)
                case .failure(let error):
                    self.finish(run: run, result: .failure(SyncFailure(
                        "Sign-in did not finish. \(error.localizedDescription) Use Sync now to try again.")))
                }
            }
        }
    }

    private func refreshLocalThenPublish(run: UUID, backend: LeaderboardSyncBackend) {
        guard let collectLocal else {
            finish(run: run, result: .failure(SyncFailure("Local usage is not ready. Try syncing again after the app finishes starting.")))
            return
        }
        statusText = "Refreshing local usage…"
        collectLocal { [weak self] result in
            self?.onMain {
                guard let self, self.activeRun == run else { return }
                switch result {
                case .failure(let error):
                    self.finish(run: run, result: .failure(SyncFailure("Could not refresh local usage. \(error.localizedDescription)")))
                case .success(let data):
                    self.statusText = "Preparing your usage…"
                    self.stageLocal(data) { [weak self] staged in
                        self?.onMain {
                            guard let self, self.activeRun == run else { return }
                            switch staged {
                            case .failure(let error):
                                self.finish(run: run, result: .failure(SyncFailure("Could not prepare your usage. \(error.localizedDescription)")))
                            case .success:
                                self.publishThenPull(run: run, backend: backend, forced: true, data: data)
                            }
                        }
                    }
                }
            }
        }
    }

    private func publishThenPull(run: UUID, backend: LeaderboardSyncBackend,
                                 forced: Bool, data: LeaderboardSyncLocalData?) {
        let writable = canPublish(backend)
        guard writable else {
            refreshRankings(run: run, backend: backend, forced: forced, data: data,
                            publication: (writable: false, didPublish: false, error: nil))
            return
        }
        statusText = "Publishing your usage…"
        publish(backend, forced) { [weak self] result in
            self?.onMain {
                guard let self, self.activeRun == run else { return }
                let error: Error?
                let didPublish: Bool
                switch result {
                case .failure(let failure):
                    let responseError = failure as NSError
                    if forced, backend == .cloud, !self.authorizationAttempted,
                       responseError.domain == "TokenHorizon",
                       responseError.code == 401 || responseError.code == 403 {
                        self.authorizeThenRefresh(run: run, backend: backend)
                        return
                    }
                    error = failure
                    didPublish = false
                case .success(let message):
                    error = nil
                    // Forced writes bypass the change gate. For background
                    // sync, claim publication only for a known publish
                    // acknowledgement, never for the cached success message.
                    didPublish = forced || message.hasPrefix("Published")
                }
                // A failed write still permits a useful rankings refresh,
                // but the overall result remains a failure and retains the
                // last successful sync timestamp.
                self.refreshRankings(run: run, backend: backend, forced: forced, data: data,
                                     publication: (writable: true, didPublish: didPublish, error: error))
            }
        }
    }

    private func refreshRankings(run: UUID, backend: LeaderboardSyncBackend,
                                 forced: Bool, data: LeaderboardSyncLocalData?,
                                 publication: (writable: Bool, didPublish: Bool, error: Error?)) {
        statusText = "Updating rankings…"
        pull(backend, forced) { [weak self] result in
            self?.onMain {
                guard let self, self.activeRun == run else { return }
                switch result {
                case .success(let count):
                    if let publishError = publication.error {
                        self.finish(run: run, result: .failure(SyncFailure(
                            "Rankings updated, but your stats were not published. \(Self.failureDetail(publishError))")))
                    } else {
                        self.statusText = publication.writable
                            ? (forced ? "Synced to \(backend == .cloud ? "cloud" : "Google Sheets")" : "Up to date")
                            : "Rankings updated · publishing unavailable"
                        self.finish(run: run, result: .success(LeaderboardSyncOutcome(
                            backend: backend, rowCount: count, localData: data, didPerformWork: true)))
                    }
                case .failure(let error):
                    let message: String
                    if let publishError = publication.error {
                        message = "Your stats were not published. \(Self.failureDetail(publishError)) Rankings could not be refreshed. \(Self.failureDetail(error))"
                    } else if publication.didPublish {
                        message = "Your stats were published, but rankings could not be refreshed. \(Self.failureDetail(error))"
                    } else {
                        message = "Could not refresh rankings. \(Self.failureDetail(error))"
                    }
                    self.finish(run: run, result: .failure(SyncFailure(message)))
                }
            }
        }
    }

    private func finish(run: UUID, result: Result<LeaderboardSyncOutcome, Error>) {
        guard activeRun == run else { return }
        if case .failure(let error) = result {
            statusText = "Sync needs attention"
            lastError = error.localizedDescription
            if !activeIsManual { lastAutomaticFailureAt = now() }
        } else {
            lastSuccessAt = now()
            lastAutomaticFailureAt = nil
        }
        let callbacks = completions
        let shouldRunManual = pendingManual
        let manualCallbacks = pendingManualCompletions
        completions = []
        pendingManual = false
        pendingManualCompletions = []
        activeRun = nil
        authorizingRun = nil
        isSyncing = false
        callbacks.forEach { $0(result) }
        if shouldRunManual {
            requestSync(forced: true, completion: { nextResult in
                manualCallbacks.forEach { $0(nextResult) }
            })
        }
    }

    private static func failureDetail(_ error: Error) -> String {
        let localError = error as NSError
        if localError.domain == "TokenHorizon" {
            // The store's credential helper distinguishes anonymous token
            // recovery from a claimed account. Preserve that specific,
            // actionable local explanation instead of replacing it.
            return error.localizedDescription
        }
        let code = localError.code
        if code == 401 || code == 403 {
            return "Check the write token and access permissions in Settings → Sharing & teams → Advanced connection, then try again."
        }
        return error.localizedDescription
    }

    private func onMain(_ action: @escaping () -> Void) {
        if Thread.isMainThread { action() } else { DispatchQueue.main.async(execute: action) }
    }

    private struct SyncFailure: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }
}
