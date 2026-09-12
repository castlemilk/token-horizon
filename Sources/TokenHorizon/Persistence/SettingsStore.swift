import Foundation
import ServiceManagement
import os

private let settingsLog = Logger(subsystem: "com.tokenhorizon.app", category: "settings")

extension Notification.Name {
    static let tokenHorizonSurfaceDidChange = Notification.Name("tokenHorizonSurfaceDidChange")
}

/// Which desktop surface Token Horizon shows.
/// auto = notch panel when a notch display is present, otherwise menu bar.
/// notch = floating top-center panel even without a notch display.
/// tray = menu-bar item with CPU/MEM rings + popover, even with a notch.
enum SurfaceMode: String, CaseIterable, Identifiable, Codable {
    case auto = "auto"
    case notch = "notch"
    case tray = "tray"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .auto: return "Auto"
        case .notch: return "Notch"
        case .tray: return "Menu bar"
        }
    }
}

final class SettingsStore {
    static let shared = SettingsStore()
    private let lock = NSLock()
    private let path: String
    private var _alibabaCookie: String = ""
    private var _notifyOnLimitRefresh: Bool = true
    private var _launchAtLogin: Bool = false
    private var _historyPersistenceEnabled: Bool = true
    private var _leaderboardHandle: String = NSUserName()
    private var _leaderboardTeam: String = ""
    private var _leaderboardRemoteURL: String = ""
    private var _leaderboardSheetsURL: String = ""
    private var _leaderboardCloudURL: String = ""
    private var _leaderboardCloudToken: String = ""
    private var _leaderboardAutoSync: Bool = false
    private var _leaderboardShareCost: Bool = true
    private var _leaderboardShareHardware: Bool = true
    /// Prompt/session history is private by default: publishing titles can
    /// leak project or client names to the public leaderboard.
    private var _leaderboardSharePrompts: Bool = false
    private var _surfaceMode: String = SurfaceMode.auto.rawValue
    private var _showTrayIcon: Bool = false

    /// Unknown stored values fall back to auto (forward-compat).
    var surfaceMode: SurfaceMode {
        get {
            lock.lock(); defer { lock.unlock() }
            return SurfaceMode(rawValue: _surfaceMode) ?? .auto
        }
        set {
            lock.lock()
            _surfaceMode = newValue.rawValue
            saveLocked()
            lock.unlock()
            NotificationCenter.default.post(name: .tokenHorizonSurfaceDidChange, object: nil)
        }
    }

    /// Keep the menu-bar item visible alongside the notch panel (both
    /// surfaces at once). No effect in tray mode, where the item always
    /// shows. Posts the same change notification as surfaceMode.
    var showTrayIcon: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _showTrayIcon }
        set {
            lock.lock()
            _showTrayIcon = newValue
            saveLocked()
            lock.unlock()
            NotificationCenter.default.post(name: .tokenHorizonSurfaceDidChange, object: nil)
        }
    }

    var leaderboardSheetsURL: String {
        get {
            lock.lock(); defer { lock.unlock() }
            return _leaderboardSheetsURL.isEmpty ? _leaderboardRemoteURL : _leaderboardSheetsURL
        }
        set {
            lock.lock()
            _leaderboardSheetsURL = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            _leaderboardRemoteURL = _leaderboardSheetsURL
            saveLocked()
            lock.unlock()
        }
    }

    /// Cloudflare Worker + R2 backend base URL (e.g. https://token-horizon.dev).
    /// Defaults to https://token-horizon.dev so any user pushes and pulls automatically.
    var leaderboardCloudURL: String {
        get {
            lock.lock(); defer { lock.unlock() }
            return _leaderboardCloudURL.isEmpty ? "https://token-horizon.dev" : _leaderboardCloudURL
        }
        set {
            lock.lock()
            _leaderboardCloudURL = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            saveLocked()
            lock.unlock()
        }
    }

    /// Alias for Cloudflare Edge Worker + R2 backend URL
    var leaderboardCloudflareURL: String {
        get { leaderboardCloudURL }
        set { leaderboardCloudURL = newValue }
    }

    /// Bearer token for `POST /leaderboard` on the cloud backend (stored with
    /// 0600 permissions alongside the other settings; never logged).
    var leaderboardCloudToken: String {
        get { lock.lock(); defer { lock.unlock() }; return _leaderboardCloudToken }
        set {
            lock.lock()
            _leaderboardCloudToken = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            saveLocked()
            lock.unlock()
        }
    }

    /// True when a cloud backend is configured (reads don't need the token).
    var leaderboardCloudConfigured: Bool {
        lock.lock(); defer { lock.unlock() }
        return !_leaderboardCloudURL.isEmpty
    }

    var leaderboardAutoSync: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _leaderboardAutoSync }
        set {
            lock.lock()
            _leaderboardAutoSync = newValue
            saveLocked()
            lock.unlock()
        }
    }

    var leaderboardHandle: String {
        get { lock.lock(); defer { lock.unlock() }; return _leaderboardHandle }
        set {
            lock.lock()
            _leaderboardHandle = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            saveLocked()
            lock.unlock()
        }
    }

    var leaderboardTeam: String {
        get { lock.lock(); defer { lock.unlock() }; return _leaderboardTeam }
        set {
            lock.lock()
            _leaderboardTeam = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            saveLocked()
            lock.unlock()
        }
    }

    var leaderboardRemoteURL: String {
        get { lock.lock(); defer { lock.unlock() }; return _leaderboardRemoteURL }
        set {
            lock.lock()
            _leaderboardRemoteURL = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            saveLocked()
            lock.unlock()
        }
    }

    var leaderboardShareCost: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _leaderboardShareCost }
        set {
            lock.lock()
            _leaderboardShareCost = newValue
            saveLocked()
            lock.unlock()
        }
    }

    var leaderboardShareHardware: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _leaderboardShareHardware }
        set {
            lock.lock()
            _leaderboardShareHardware = newValue
            saveLocked()
            lock.unlock()
        }
    }

    var leaderboardSharePrompts: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _leaderboardSharePrompts }
        set {
            lock.lock()
            _leaderboardSharePrompts = newValue
            saveLocked()
            lock.unlock()
        }
    }

    var historyPersistenceEnabled: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _historyPersistenceEnabled }
        set {
            lock.lock()
            _historyPersistenceEnabled = newValue
            saveLocked()
            lock.unlock()
        }
    }

    var alibabaCookie: String {
        get { lock.lock(); defer { lock.unlock() }; return _alibabaCookie }
        set {
            lock.lock()
            _alibabaCookie = newValue
            saveLocked()
            lock.unlock()
        }
    }

    var notifyOnLimitRefresh: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _notifyOnLimitRefresh }
        set {
            lock.lock()
            _notifyOnLimitRefresh = newValue
            saveLocked()
            lock.unlock()
        }
    }

    var launchAtLogin: Bool {
        get {
            lock.lock()
            if SMAppService.mainApp.status == .enabled { _launchAtLogin = true }
            lock.unlock()
            return _launchAtLogin
        }
        set {
            lock.lock()
            _launchAtLogin = newValue
            lock.unlock()
            applyLaunchAtLogin(newValue)
            saveLocked()
        }
    }

    private func applyLaunchAtLogin(_ enabled: Bool) {
        let mgr = SMAppService.mainApp
        if enabled {
            do {
                if mgr.status == .enabled {
                    try? mgr.unregister()
                }
                try mgr.register()
            } catch {
                settingsLog.error("Failed to register launch at login: \(String(describing: error))")
            }
        } else {
            if mgr.status == .enabled {
                try? mgr.unregister()
            }
        }
    }

    private func saveLocked() {
        let payload: [String: Any] = [
            "alibabaCookie": _alibabaCookie,
            "notifyOnLimitRefresh": _notifyOnLimitRefresh,
            "launchAtLogin": _launchAtLogin,
            "historyPersistenceEnabled": _historyPersistenceEnabled,
            "leaderboardHandle": _leaderboardHandle,
            "leaderboardTeam": _leaderboardTeam,
            "leaderboardRemoteURL": _leaderboardRemoteURL,
            "leaderboardSheetsURL": _leaderboardSheetsURL,
            "leaderboardCloudURL": _leaderboardCloudURL,
            "leaderboardCloudflareURL": _leaderboardCloudURL,
            "leaderboardCloudToken": _leaderboardCloudToken,
            "leaderboardAutoSync": _leaderboardAutoSync,
            "leaderboardShareCost": _leaderboardShareCost,
            "leaderboardShareHardware": _leaderboardShareHardware,
            "leaderboardSharePrompts": _leaderboardSharePrompts,
            "surfaceMode": _surfaceMode,
            "showTrayIcon": _showTrayIcon
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload) {
            try? data.write(to: URL(fileURLWithPath: path))
            chmod(path, 0o600)
        }
    }

    private init() {
        let dir = NSString(string: "~/.config/token-horizon").expandingTildeInPath
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        path = dir + "/settings.json"
        var c = ""
        var notify = true
        var launch = false
        var history = true
        var handle = NSUserName()
        var team = ""
        var remoteURL = ""
        var sheetsURL = ""
        var cloudURL = ""
        var cloudToken = ""
        var autoSync = false
        var shareCost = true
        var shareHardware = true
        var sharePrompts = false
        var surfaceMode = SurfaceMode.auto.rawValue
        var showTrayIcon = false

        if let data = FileManager.default.contents(atPath: path),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            c = obj["alibabaCookie"] as? String ?? ""
            if let n = obj["notifyOnLimitRefresh"] as? Bool {
                notify = n
            }
            if let l = obj["launchAtLogin"] as? Bool {
                launch = l
            }
            if let h = obj["historyPersistenceEnabled"] as? Bool {
                history = h
            }
            if let lh = obj["leaderboardHandle"] as? String, !lh.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                handle = lh.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if let lt = obj["leaderboardTeam"] as? String {
                team = lt.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if let lr = obj["leaderboardRemoteURL"] as? String {
                remoteURL = lr.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if let ls = obj["leaderboardSheetsURL"] as? String {
                sheetsURL = ls.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if let lc = (obj["leaderboardCloudflareURL"] ?? obj["leaderboardCloudURL"]) as? String {
                cloudURL = lc.trimmingCharacters(in: .whitespacesAndNewlines)
                    .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            }
            if let lt = obj["leaderboardCloudToken"] as? String {
                cloudToken = lt.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if let las = obj["leaderboardAutoSync"] as? Bool {
                autoSync = las
            }
            if let lsc = obj["leaderboardShareCost"] as? Bool {
                shareCost = lsc
            }
            if let lsh = obj["leaderboardShareHardware"] as? Bool {
                shareHardware = lsh
            }
            if let lsp = obj["leaderboardSharePrompts"] as? Bool {
                sharePrompts = lsp
            }
            if let sm = obj["surfaceMode"] as? String,
               SurfaceMode(rawValue: sm.trimmingCharacters(in: .whitespacesAndNewlines)) != nil {
                surfaceMode = sm.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if let sti = obj["showTrayIcon"] as? Bool {
                showTrayIcon = sti
            }
        }
        if c.isEmpty {
            let fb = NSString(string: "~/.config/token-horizon/alibaba-cookie.txt").expandingTildeInPath
            c = (try? String(contentsOfFile: fb, encoding: .utf8)) ?? ""
        }
        _alibabaCookie = c.trimmingCharacters(in: .whitespacesAndNewlines)
        _notifyOnLimitRefresh = notify
        _launchAtLogin = launch
        _historyPersistenceEnabled = history
        _leaderboardHandle = handle
        _leaderboardTeam = team
        _leaderboardRemoteURL = remoteURL
        _leaderboardSheetsURL = sheetsURL.isEmpty ? remoteURL : sheetsURL
        // Domain migration: the leaderboard edge moved to token-horizon.dev.
        // Rewrite the legacy host so existing installs cut over automatically.
        if cloudURL.hasPrefix("https://tokens.benebsworth.com") {
            cloudURL = cloudURL.replacingOccurrences(
                of: "https://tokens.benebsworth.com", with: "https://token-horizon.dev")
        }
        if cloudURL.isEmpty {
            cloudURL = "https://token-horizon.dev"
        }
        _leaderboardCloudURL = cloudURL
        _leaderboardCloudToken = cloudToken
        _leaderboardAutoSync = autoSync
        _leaderboardShareCost = shareCost
        _leaderboardShareHardware = shareHardware
        _leaderboardSharePrompts = sharePrompts
        _surfaceMode = surfaceMode
        _showTrayIcon = showTrayIcon

        DispatchQueue.global(qos: .utility).async { [self] in
            if launch { applyLaunchAtLogin(true) }
        }
    }

    func getCookie() -> String { alibabaCookie }

    func setCookie(_ s: String) { alibabaCookie = s }
}
