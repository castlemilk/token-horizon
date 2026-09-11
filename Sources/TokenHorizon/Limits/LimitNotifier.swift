import Foundation
import TokenHorizonCore
#if canImport(UserNotifications)
import UserNotifications
#endif

final class LimitNotifier: NSObject {
    static let shared = LimitNotifier()

    private let lock = NSLock()
    struct LimitState {
        var usedPercent: Double
        var resetsAt: Date?
        var detail: String
        var lastUpdated: Date
    }

    private var previousStates: [String: LimitState] = [:]
    private var lastNotifiedTimes: [String: Date] = [:]
    private var isSeeded = false

    private static var isAppBundle: Bool {
        Bundle.main.bundlePath.hasSuffix(".app")
    }

    override init() {
        super.init()
        requestAuthorization()
    }

    func requestAuthorization() {
        #if canImport(UserNotifications)
        guard Self.isAppBundle else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        #endif
    }

    func checkLimits(_ limits: [ProviderLimit]) {
        guard SettingsStore.shared.notifyOnLimitRefresh else { return }
        lock.lock()
        defer { lock.unlock() }

        let now = Date()
        if !isSeeded {
            for limit in limits {
                let key = makeKey(provider: limit.provider, label: limit.label)
                previousStates[key] = LimitState(usedPercent: limit.usedPercent,
                                                 resetsAt: limit.resetsAt,
                                                 detail: limit.detail,
                                                 lastUpdated: now)
            }
            isSeeded = true
            return
        }

        for limit in limits {
            let key = makeKey(provider: limit.provider, label: limit.label)
            let prev = previousStates[key]
            previousStates[key] = LimitState(usedPercent: limit.usedPercent,
                                             resetsAt: limit.resetsAt,
                                             detail: limit.detail,
                                             lastUpdated: now)

            guard let prev else { continue }

            // Deduplicate: Don't notify for the same key more often than once every 60 seconds
            if let lastNotified = lastNotifiedTimes[key], now.timeIntervalSince(lastNotified) < 60 {
                continue
            }

            if isRefresh(prev: prev, current: limit, now: now) {
                lastNotifiedTimes[key] = now
                dispatchNotification(for: limit, prev: prev)
            }
        }
    }

    func isRefresh(prev: LimitState, current: ProviderLimit, now: Date) -> Bool {
        // 1. Cleared rate-limit state
        if prev.detail.contains("rate-limited") && !current.detail.contains("rate-limited") && current.usedPercent < 100 {
            return true
        }

        // 2. Significant usage drop (e.g. from >=35% down by at least 15%)
        if prev.usedPercent >= 35.0 && current.usedPercent < (prev.usedPercent - 15.0) {
            return true
        }

        // 3. Dropped to 0% used from any non-trivial usage (>=15%)
        if prev.usedPercent >= 15.0 && current.usedPercent == 0.0 {
            return true
        }

        // 4. Reset timestamp passed and subsequent window started with lower usage
        if let resetDate = prev.resetsAt, resetDate <= now {
            if (current.resetsAt == nil || current.resetsAt! > resetDate) && current.usedPercent < prev.usedPercent {
                return true
            }
        }

        return false
    }

    private func dispatchNotification(for limit: ProviderLimit, prev: LimitState) {
        let pName = providerDisplayName(limit.provider)
        let title = "Token Horizon"
        let subtitle = "\(pName) · \(limit.label.uppercased()) Quota Refreshed"

        var detailDesc = ""
        if !limit.detail.isEmpty {
            detailDesc = " (\(limit.detail))"
        } else {
            detailDesc = String(format: " (%.0f%% used)", limit.usedPercent)
        }
        let body = "\(pName) limit has refreshed\(detailDesc)."

        #if canImport(UserNotifications)
        if Self.isAppBundle {
            let content = UNMutableNotificationContent()
            content.title = title
            content.subtitle = subtitle
            content.body = body
            content.sound = .default

            let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            UNUserNotificationCenter.current().add(req) { [weak self] error in
                if error != nil {
                    self?.fallbackScriptNotify(title: title, subtitle: subtitle, body: body)
                }
            }
        } else {
            fallbackScriptNotify(title: title, subtitle: subtitle, body: body)
        }
        #else
        fallbackScriptNotify(title: title, subtitle: subtitle, body: body)
        #endif
    }

    private func fallbackScriptNotify(title: String, subtitle: String, body: String) {
        #if os(macOS)
        let cleanTitle = title.replacingOccurrences(of: "\"", with: "\\\"")
        let cleanSub = subtitle.replacingOccurrences(of: "\"", with: "\\\"")
        let cleanBody = body.replacingOccurrences(of: "\"", with: "\\\"")
        let script = "display notification \"\(cleanBody)\" with title \"\(cleanTitle)\" subtitle \"\(cleanSub)\""

        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", script]
        try? p.run()
        #endif
    }

    /// Dedup key. Internal for hermetic unit tests.
    func makeKey(provider: String, label: String) -> String {
        "\(provider.lowercased()):\(label.lowercased())"
    }

    /// Human provider name. Internal for hermetic unit tests.
    func providerDisplayName(_ raw: String) -> String {
        switch raw.lowercased() {
        case "codex", "openai": return "OpenAI"
        case "kimi": return "Kimi"
        case "glm", "zai": return "GLM"
        case "minimax": return "MiniMax"
        case "opencode", "opencode-go": return "OpenCode"
        case "agy", "antigravity": return "AGY"
        case "gemini", "google": return "Google"
        case "alibaba", "qwen": return "Alibaba"
        case "claude", "anthropic": return "Claude"
        case "deepseek": return "DeepSeek"
        default: return raw.capitalized
        }
    }
}

#if canImport(UserNotifications)
extension LimitNotifier: UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
#endif
