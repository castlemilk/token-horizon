import Foundation
import XCTest
@testable import TokenHorizon

final class LeaderboardSyncControllerTests: XCTestCase {
    private final class Harness {
        var events: [String] = []
        var backend: LeaderboardSyncBackend? = .cloud
        var writable = true
        var needsSignIn = false
        var automaticWork = true
        var clock = Date(timeIntervalSince1970: 1_800_000_000)
        let data = LeaderboardSyncLocalData(snapshot: .empty, history: [], streak: 4, heatmap: [[3]])
        var collected: ((Result<LeaderboardSyncLocalData, Error>) -> Void)?
        var authorized: ((Result<Void, Error>) -> Void)?
        var staged: ((Result<Void, Error>) -> Void)?
        var published: ((Result<String, Error>) -> Void)?
        var pulled: ((Result<Int, Error>) -> Void)?

        lazy var controller = LeaderboardSyncController(
            collectLocal: { completion in
                self.events.append("collect")
                self.collected = completion
            },
            stageLocal: { data, completion in
                XCTAssertEqual(data.streak, 4)
                XCTAssertEqual(data.heatmap, [[3]])
                self.events.append("stage")
                self.staged = completion
            },
            resolveBackend: { _ in self.backend },
            authNeeded: { self.needsSignIn },
            authorize: { completion in
                self.events.append("authorize")
                self.authorized = completion
            },
            canPublish: { _ in self.writable },
            hasAutomaticWork: { _ in self.automaticWork },
            publish: { backend, forced, completion in
                self.events.append("publish:\(backend):\(forced)")
                self.published = completion
            },
            pull: { backend, forced, completion in
                self.events.append("pull:\(backend):\(forced)")
                self.pulled = completion
            },
            now: { self.clock }
        )

        func prepareManual() {
            collected?(.success(data))
            staged?(.success(()))
        }

        func finishSuccess() {
            published?(.success("Published"))
            pulled?(.success(7))
        }
    }

    private func onMain(_ action: () -> Void) {
        if Thread.isMainThread { action() } else { DispatchQueue.main.sync(execute: action) }
    }

    private func error(_ code: Int = 500, _ message: String = "Network unavailable") -> Error {
        NSError(domain: "SyncTest", code: code, userInfo: [NSLocalizedDescriptionKey: message])
    }

    func testBackendResolution_preservesExplicitChoiceAndManualDefault() {
        XCTAssertEqual(LeaderboardSyncController.backend(cloudConfigured: true, sheetsURL: "sheet", forced: false), .cloud)
        XCTAssertEqual(LeaderboardSyncController.backend(cloudConfigured: false, sheetsURL: "sheet", forced: true), .sheets)
        XCTAssertNil(LeaderboardSyncController.backend(cloudConfigured: false, sheetsURL: "  ", forced: false))
        XCTAssertEqual(LeaderboardSyncController.backend(cloudConfigured: false, sheetsURL: "", forced: true), .cloud)
    }

    func testManualSync_collectsAndStagesOnceThenPublishesBeforePull() {
        onMain {
            let harness = Harness()
            var finished = false
            harness.controller.syncNow { result in
                guard case .success(let outcome) = result else { return XCTFail("Expected success") }
                XCTAssertEqual(outcome.rowCount, 7)
                XCTAssertEqual(outcome.localData?.streak, 4)
                XCTAssertTrue(outcome.didPerformWork)
                finished = true
            }
            XCTAssertEqual(harness.events, ["collect"])
            XCTAssertTrue(harness.controller.isSyncing)
            harness.collected?(.success(harness.data))
            XCTAssertEqual(harness.events, ["collect", "stage"])
            harness.staged?(.success(()))
            XCTAssertEqual(harness.events, ["collect", "stage", "publish:cloud:true"])
            harness.published?(.success("Published"))
            XCTAssertEqual(harness.events.last, "pull:cloud:true")
            XCTAssertTrue(harness.controller.isSyncing, "Keep the button busy until rankings finish")
            XCTAssertFalse(finished)
            harness.pulled?(.success(7))
            XCTAssertTrue(finished)
            XCTAssertFalse(harness.controller.isSyncing)
            XCTAssertEqual(harness.controller.lastSuccessAt, harness.clock)
            XCTAssertNil(harness.controller.lastError)
        }
    }

    func testManualCloudSync_signsInBeforeReadingOrPublishingThenResumesOnce() {
        onMain {
            let harness = Harness()
            harness.needsSignIn = true
            var completed = 0
            harness.controller.syncNow { _ in completed += 1 }
            harness.controller.syncNow { _ in completed += 1 }
            XCTAssertEqual(harness.events, ["authorize"])
            XCTAssertEqual(harness.controller.statusText, "Sign in to sync")
            XCTAssertTrue(harness.controller.isSyncing)
            harness.needsSignIn = false
            harness.authorized?(.success(()))
            XCTAssertEqual(harness.events, ["authorize", "collect"])
            harness.authorized?(.success(()))
            XCTAssertEqual(harness.events, ["authorize", "collect"], "Ignore duplicate authorization callbacks")
            harness.prepareManual()
            harness.finishSuccess()
            XCTAssertEqual(harness.events, ["authorize", "collect", "stage", "publish:cloud:true", "pull:cloud:true"])
            XCTAssertEqual(completed, 2)
            XCTAssertFalse(harness.controller.isSyncing)
            XCTAssertEqual(harness.controller.lastSuccessAt, harness.clock)
        }
    }

    func testCancelledSignIn_stopsBeforeCollectionAndAllowsManualRetry() {
        onMain {
            let harness = Harness()
            harness.needsSignIn = true
            var failed = false
            harness.controller.syncNow { result in
                if case .failure = result { failed = true }
            }
            harness.authorized?(.failure(self.error(NSUserCancelledError, "Sign-in was cancelled.")))
            XCTAssertTrue(failed)
            XCTAssertEqual(harness.events, ["authorize"])
            XCTAssertFalse(harness.controller.isSyncing)
            XCTAssertNil(harness.controller.lastSuccessAt)
            XCTAssertTrue(harness.controller.lastError?.contains("cancelled") ?? false)
            XCTAssertTrue(harness.controller.lastError?.contains("Sync now") ?? false)
            harness.authorized?(.success(()))
            XCTAssertEqual(harness.events, ["authorize"], "A late callback must not revive a cancelled sync")
            harness.controller.syncNow()
            XCTAssertEqual(harness.events, ["authorize", "authorize"])
        }
    }

    func testAutomaticCloudWithoutSignIn_skipsAllWorkAndPreservesLastResult() {
        onMain {
            let harness = Harness()
            harness.controller.syncNow()
            harness.prepareManual()
            harness.finishSuccess()
            let previousSuccess = harness.controller.lastSuccessAt
            harness.controller.syncNow()
            harness.collected?(.failure(self.error()))
            let previousError = harness.controller.lastError
            let previousStatus = harness.controller.statusText
            let previousEvents = harness.events
            harness.needsSignIn = true
            var skipped = false
            harness.controller.syncAutomatically { result in
                if case .success(let outcome) = result { skipped = !outcome.didPerformWork }
            }
            XCTAssertTrue(skipped)
            XCTAssertEqual(harness.events, previousEvents)
            XCTAssertEqual(harness.controller.lastSuccessAt, previousSuccess)
            XCTAssertEqual(harness.controller.lastError, previousError)
            XCTAssertEqual(harness.controller.statusText, previousStatus)
            XCTAssertFalse(harness.controller.isSyncing)
        }
    }

    func testSheetsSync_doesNotAskForCloudSignIn() {
        onMain {
            let harness = Harness()
            harness.backend = .sheets
            harness.needsSignIn = true
            harness.controller.syncNow()
            XCTAssertEqual(harness.events, ["collect"])
            harness.prepareManual()
            harness.finishSuccess()
            XCTAssertEqual(harness.events, ["collect", "stage", "publish:sheets:true", "pull:sheets:true"])
        }
    }

    func testLegacyWriteTokenRejected_signsInAndRestagesBeforeRetry() {
        onMain {
            let harness = Harness()
            var completed = 0
            harness.controller.syncNow { result in
                guard case .success = result else { return XCTFail("Expected recovered sync") }
                completed += 1
            }
            harness.prepareManual()
            harness.published?(.failure(NSError(domain: "TokenHorizon", code: 401,
                                               userInfo: [NSLocalizedDescriptionKey: "Legacy token rejected"])))
            XCTAssertEqual(harness.events, ["collect", "stage", "publish:cloud:true", "authorize"])
            XCTAssertEqual(harness.controller.statusText, "Sign in to sync")
            XCTAssertTrue(harness.controller.isSyncing)
            harness.authorized?(.success(()))
            XCTAssertEqual(harness.events.last, "collect", "Read fresh usage with the identity selected in the browser")
            harness.authorized?(.success(()))
            XCTAssertEqual(harness.events.filter { $0 == "collect" }.count, 2)
            harness.prepareManual()
            harness.finishSuccess()
            XCTAssertEqual(harness.events, ["collect", "stage", "publish:cloud:true", "authorize",
                                            "collect", "stage", "publish:cloud:true", "pull:cloud:true"])
            XCTAssertEqual(completed, 1)
            XCTAssertEqual(harness.controller.lastSuccessAt, harness.clock)
            XCTAssertFalse(harness.controller.isSyncing)
        }
    }

    func testCancelledReconnect_stopsRetryAndPreservesLastSuccess() {
        onMain {
            let harness = Harness()
            harness.controller.syncNow()
            harness.prepareManual()
            harness.finishSuccess()
            let successfulAt = harness.controller.lastSuccessAt
            harness.clock = harness.clock.addingTimeInterval(60)
            var failed = false
            harness.controller.syncNow { result in
                if case .failure = result { failed = true }
            }
            harness.prepareManual()
            harness.published?(.failure(NSError(domain: "TokenHorizon", code: 403,
                                               userInfo: [NSLocalizedDescriptionKey: "Profile ownership rejected"])))
            harness.authorized?(.failure(self.error(NSUserCancelledError, "Sign-in was cancelled.")))
            let completedEvents = harness.events
            harness.authorized?(.success(()))
            XCTAssertEqual(harness.events, completedEvents, "Late browser approval cannot revive a cancelled run")
            XCTAssertTrue(failed)
            XCTAssertFalse(harness.controller.isSyncing)
            XCTAssertEqual(harness.controller.lastSuccessAt, successfulAt)
            XCTAssertEqual(harness.events.filter { $0.hasPrefix("publish:") }.count, 2)
            XCTAssertEqual(harness.events.filter { $0.hasPrefix("pull:") }.count, 1)
            XCTAssertTrue(harness.controller.lastError?.contains("cancelled") ?? false)
        }
    }

    func testReconnectThenRejectedPublish_authorizesOnlyOnceAndReportsFailure() {
        onMain {
            let harness = Harness()
            var failed = false
            harness.controller.syncNow { result in
                if case .failure = result { failed = true }
            }
            harness.prepareManual()
            harness.published?(.failure(NSError(domain: "TokenHorizon", code: 401)))
            harness.authorized?(.success(()))
            harness.prepareManual()
            harness.published?(.failure(NSError(domain: "TokenHorizon", code: 403,
                                               userInfo: [NSLocalizedDescriptionKey: "Still rejected"])))
            XCTAssertEqual(harness.events.last, "pull:cloud:true")
            harness.pulled?(.success(7))
            XCTAssertTrue(failed)
            XCTAssertEqual(harness.events.filter { $0 == "authorize" }.count, 1)
            XCTAssertEqual(harness.events.filter { $0.hasPrefix("publish:") }.count, 2)
            XCTAssertFalse(harness.controller.isSyncing)
            XCTAssertNil(harness.controller.lastSuccessAt)
            XCTAssertTrue(harness.controller.lastError?.contains("Still rejected") ?? false)
        }
    }

    func testInitialSignInConsumesRecoveryAttempt() {
        onMain {
            let harness = Harness()
            harness.needsSignIn = true
            harness.controller.syncNow()
            harness.authorized?(.success(()))
            harness.prepareManual()
            harness.published?(.failure(NSError(domain: "TokenHorizon", code: 401)))
            XCTAssertEqual(harness.events, ["authorize", "collect", "stage", "publish:cloud:true", "pull:cloud:true"])
            harness.pulled?(.success(7))
            XCTAssertEqual(harness.events.filter { $0 == "authorize" }.count, 1)
            XCTAssertFalse(harness.controller.isSyncing)
            XCTAssertNotNil(harness.controller.lastError)
        }
    }

    func testAutomaticCloudAuthRejection_doesNotOpenSignIn() {
        onMain {
            let harness = Harness()
            harness.controller.syncAutomatically()
            harness.published?(.failure(NSError(domain: "TokenHorizon", code: 401)))
            harness.pulled?(.success(7))
            XCTAssertEqual(harness.events, ["publish:cloud:false", "pull:cloud:false"])
            XCTAssertFalse(harness.controller.isSyncing)
            XCTAssertNotNil(harness.controller.lastError)
        }
    }

    func testSheetsAuthRejection_doesNotOpenCloudSignIn() {
        onMain {
            let harness = Harness()
            harness.backend = .sheets
            harness.controller.syncNow()
            harness.prepareManual()
            harness.published?(.failure(NSError(domain: "TokenHorizon", code: 403)))
            harness.pulled?(.success(7))
            XCTAssertEqual(harness.events, ["collect", "stage", "publish:sheets:true", "pull:sheets:true"])
            XCTAssertFalse(harness.controller.isSyncing)
            XCTAssertNotNil(harness.controller.lastError)
        }
    }

    func testManualRequestsAcrossSurfaces_coalesceActiveRun() {
        onMain {
            let harness = Harness()
            var completed = 0
            harness.controller.syncNow { _ in completed += 1 }
            harness.controller.syncNow { _ in completed += 1 }
            harness.controller.syncAutomatically { _ in completed += 1 }
            XCTAssertEqual(harness.events, ["collect"])
            harness.prepareManual()
            harness.finishSuccess()
            XCTAssertEqual(completed, 3)
            XCTAssertEqual(harness.events.filter { $0 == "stage" }.count, 1)
            XCTAssertEqual(harness.events.filter { $0.hasPrefix("publish:") }.count, 1)
        }
    }

    func testManualDuringAutomaticRun_queuesOneForcedFreshRun() {
        onMain {
            let harness = Harness()
            var automaticCompleted = false
            var manualCompleted = 0
            harness.controller.syncAutomatically { _ in automaticCompleted = true }
            XCTAssertEqual(harness.events, ["publish:cloud:false"])
            harness.controller.syncNow { _ in manualCompleted += 1 }
            harness.controller.syncNow { _ in manualCompleted += 1 }
            XCTAssertEqual(harness.events, ["publish:cloud:false"])
            harness.finishSuccess()
            XCTAssertTrue(automaticCompleted)
            XCTAssertEqual(manualCompleted, 0, "Manual callers must await their forced operation")
            XCTAssertEqual(harness.events, ["publish:cloud:false", "pull:cloud:false", "collect"])
            XCTAssertTrue(harness.controller.isSyncing)
            harness.prepareManual()
            harness.finishSuccess()
            XCTAssertEqual(manualCompleted, 2)
            XCTAssertEqual(harness.events.filter { $0 == "collect" }.count, 1)
            XCTAssertEqual(harness.events.filter { $0 == "publish:cloud:true" }.count, 1)
        }
    }

    func testAutomaticSync_usesStagedUsageAndPreservesPolicyFlags() {
        onMain {
            let harness = Harness()
            harness.controller.syncAutomatically()
            harness.finishSuccess()
            XCTAssertEqual(harness.events, ["publish:cloud:false", "pull:cloud:false"])
            XCTAssertEqual(harness.controller.statusText, "Up to date")
        }
    }

    func testAutomaticNoWork_doesNotInventSuccessOrHideFailure() {
        onMain {
            let harness = Harness()
            harness.controller.syncAutomatically()
            harness.finishSuccess()
            let previousSuccess = harness.controller.lastSuccessAt
            harness.clock = harness.clock.addingTimeInterval(60)
            harness.controller.syncAutomatically()
            harness.published?(.failure(self.error()))
            harness.pulled?(.success(7))
            let previousError = harness.controller.lastError
            let previousStatus = harness.controller.statusText
            harness.automaticWork = false
            let previousEvents = harness.events
            var didPerformWork = true
            harness.controller.syncAutomatically { result in
                if case .success(let outcome) = result { didPerformWork = outcome.didPerformWork }
            }
            XCTAssertEqual(harness.events, previousEvents)
            XCTAssertEqual(harness.controller.lastSuccessAt, previousSuccess)
            XCTAssertEqual(harness.controller.lastError, previousError)
            XCTAssertEqual(harness.controller.statusText, previousStatus)
            XCTAssertFalse(didPerformWork)
        }
    }

    func testReadOnlySheets_refreshesRankingsWithoutPublishing() {
        onMain {
            let harness = Harness()
            harness.backend = .sheets
            harness.writable = false
            harness.controller.syncNow()
            harness.prepareManual()
            XCTAssertEqual(harness.events, ["collect", "stage", "pull:sheets:true"])
            harness.pulled?(.success(9))
            XCTAssertEqual(harness.controller.statusText, "Rankings updated · publishing unavailable")
            XCTAssertNil(harness.controller.lastError)
            XCTAssertEqual(harness.controller.lastSuccessAt, harness.clock)
        }
    }

    func testAutomaticFailure_retriesOnlyAfterBackoffBoundary() {
        onMain {
            let harness = Harness()
            harness.controller.syncAutomatically()
            harness.published?(.failure(self.error(403)))
            harness.pulled?(.success(7))
            let previousEvents = harness.events
            let previousError = harness.controller.lastError
            harness.clock = harness.clock.addingTimeInterval(
                LeaderboardSyncController.automaticFailureRetryInterval - 1)
            harness.controller.syncAutomatically()
            XCTAssertEqual(harness.events, previousEvents)
            XCTAssertEqual(harness.controller.lastError, previousError)
            XCTAssertNil(harness.controller.lastSuccessAt)
            harness.clock = harness.clock.addingTimeInterval(1)
            harness.controller.syncAutomatically()
            XCTAssertEqual(harness.events.count, previousEvents.count + 1)
            harness.finishSuccess()
            XCTAssertEqual(harness.controller.lastSuccessAt, harness.clock)
            XCTAssertNil(harness.controller.lastError)
        }
    }

    func testManualSync_bypassesAutomaticFailureBackoff() {
        onMain {
            let harness = Harness()
            harness.controller.syncAutomatically()
            harness.published?(.failure(self.error(401)))
            harness.pulled?(.success(7))
            harness.controller.syncNow()
            XCTAssertEqual(harness.events.last, "collect")
            XCTAssertTrue(harness.controller.isSyncing)
            harness.prepareManual()
            harness.finishSuccess()
            XCTAssertNil(harness.controller.lastError)
            XCTAssertEqual(harness.controller.lastSuccessAt, harness.clock)
        }
    }

    func testPublishRejected_stillPullsAndRetainsLastSuccessWithActionableError() {
        onMain {
            let harness = Harness()
            harness.controller.syncNow()
            harness.prepareManual()
            harness.finishSuccess()
            let successfulAt = harness.controller.lastSuccessAt
            harness.clock = harness.clock.addingTimeInterval(60)
            var failed = false
            harness.controller.syncNow { result in
                if case .failure = result { failed = true }
            }
            harness.prepareManual()
            harness.published?(.failure(self.error(401, "Unauthorized")))
            XCTAssertEqual(harness.events.last, "pull:cloud:true")
            harness.pulled?(.success(7))
            XCTAssertTrue(failed)
            XCTAssertEqual(harness.controller.lastSuccessAt, successfulAt)
            XCTAssertTrue(harness.controller.lastError?.contains("write token") ?? false)
            XCTAssertTrue(harness.controller.lastError?.contains("not published") ?? false)
            XCTAssertFalse(harness.controller.isSyncing)
        }
    }

    func testPullFailure_isNotReportedAsSuccessfulSync() {
        onMain {
            let harness = Harness()
            harness.controller.syncNow()
            harness.prepareManual()
            harness.published?(.success("Published"))
            harness.pulled?(.failure(self.error()))
            XCTAssertNil(harness.controller.lastSuccessAt)
            XCTAssertTrue(harness.controller.lastError?.contains("rankings could not be refreshed") ?? false)
            XCTAssertEqual(harness.controller.statusText, "Sync needs attention")
        }
    }

    func testTrustedCredentialFailure_preservesRecoveryInstructions() {
        onMain {
            let harness = Harness()
            harness.needsSignIn = true
            let message = "Restore the original anonymous claim token in Advanced connection."
            harness.controller.syncNow()
            harness.authorized?(.success(()))
            harness.prepareManual()
            harness.published?(.failure(NSError(domain: "TokenHorizon", code: 403,
                                               userInfo: [NSLocalizedDescriptionKey: message])))
            harness.pulled?(.success(7))
            XCTAssertTrue(harness.controller.lastError?.contains(message) ?? false)
        }
    }

    func testAutomaticSkippedPublishAndFailedPull_doesNotClaimPublication() {
        onMain {
            let harness = Harness()
            harness.controller.syncAutomatically()
            harness.published?(.success("Board is already up to date."))
            harness.pulled?(.failure(self.error()))
            XCTAssertNil(harness.controller.lastSuccessAt)
            XCTAssertTrue(harness.controller.lastError?.hasPrefix("Could not refresh rankings.") ?? false)
            XCTAssertFalse(harness.controller.lastError?.contains("were published") ?? true)
        }
    }

    func testCollectionFailure_preventsStagingAndRemoteOperations() {
        onMain {
            let harness = Harness()
            harness.controller.syncNow()
            harness.collected?(.failure(self.error()))
            XCTAssertEqual(harness.events, ["collect"])
            XCTAssertFalse(harness.controller.isSyncing)
            XCTAssertNil(harness.controller.lastSuccessAt)
            XCTAssertTrue(harness.controller.lastError?.contains("local usage") ?? false)
        }
    }

    func testBackgroundCallbacks_deliverCompletionOnMain() {
        let done = expectation(description: "Completion arrives on main")
        let controller = LeaderboardSyncController(
            collectLocal: { completion in
                DispatchQueue.global().async {
                    completion(.success(LeaderboardSyncLocalData(snapshot: .empty, history: [], streak: 0, heatmap: nil)))
                }
            },
            stageLocal: { _, completion in
                XCTAssertTrue(Thread.isMainThread)
                completion(.success(()))
            },
            resolveBackend: { _ in .cloud },
            authNeeded: { false },
            canPublish: { _ in true },
            hasAutomaticWork: { _ in true },
            publish: { _, _, completion in completion(.success("Published")) },
            pull: { _, _, completion in completion(.success(2)) }
        )
        controller.syncNow { _ in
            XCTAssertTrue(Thread.isMainThread)
            XCTAssertFalse(controller.isSyncing)
            done.fulfill()
        }
        wait(for: [done], timeout: 2)
    }
}
