import Foundation

/// The cloud identity the UI signed in with, persisted for the DAEMON.
///
/// The OAuth dance happens in the desktop UI (browser round-trip against
/// the Go server). On success the UI POSTs the resulting identity to the
/// loopback API (POST /cloud/identity); the daemon saves it here (0600,
/// config dir) and applies it to CloudSync, so usage sync keeps
/// attributing to the right user while the UI app is closed — and the
/// daemon reapplies it at boot before the sync timer starts.
///
/// The record deliberately carries NO session token: ingest authenticates
/// with the deployment's service token (server `Token`), and attribution
/// only needs handle + user_id. Tokens stay in the UI's localStorage.
public struct CloudIdentity: Codable, Equatable {
    public var baseURL: String
    public var handle: String
    public var userID: String
    public var team: String
    public var displayName: String
    public var avatarURL: String
    /// Epoch seconds when the UI handed this over.
    public var savedAt: Double

    public init(baseURL: String, handle: String, userID: String, team: String = "",
                displayName: String = "", avatarURL: String = "", savedAt: Double = 0) {
        self.baseURL = baseURL
        self.handle = handle
        self.userID = userID
        self.team = team
        self.displayName = displayName
        self.avatarURL = avatarURL
        self.savedAt = savedAt > 0 ? savedAt : Date().timeIntervalSince1970
    }
}

public enum CloudIdentityStore {
    /// Test seam: point persistence at a temp file.
    public static var pathOverride: String?

    public static var path: String {
        pathOverride ?? (Platform.paths.configDirectory.path + "/cloud-identity.json")
    }

    public static func load() -> CloudIdentity? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        return try? JSONDecoder().decode(CloudIdentity.self, from: data)
    }

    public static func save(_ identity: CloudIdentity) throws {
        let dir = Platform.paths.configDirectory.path
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(identity)
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        chmod(path, 0o600)
    }

    public static func clear() {
        try? FileManager.default.removeItem(atPath: path)
    }

    /// Apply to a sync engine: sync target + envelope identity. An empty
    /// baseURL keeps the engine's current target (env TH_SYNC_URL).
    public static func apply(_ identity: CloudIdentity, to sync: CloudSync) {
        if !identity.baseURL.isEmpty, let url = URL(string: identity.baseURL) {
            sync.baseURL = url
        }
        sync.handle = identity.handle
        sync.team = identity.team
        sync.userID = identity.userID
    }
}
