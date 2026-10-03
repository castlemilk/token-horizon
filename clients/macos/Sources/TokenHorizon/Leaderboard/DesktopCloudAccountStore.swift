import Foundation
import Security

/// A profile-scoped desktop grant. The credential stays in Keychain and never
/// enters leaderboard snapshots, settings exports, browser URLs, or logs.
struct DesktopCloudAccount: Codable {
    struct User: Codable {
        let provider: String
        let sub: String
        let name: String?
        let email: String?
        let picture: String?
        let login: String?
    }
    let endpoint: String
    let handle: String
    let accessToken: String
    let expiresAt: Date
    let user: User

    var displayName: String { user.name.flatMap { $0.isEmpty ? nil : $0 } ?? user.email ?? user.login ?? "Your account" }
}

final class DesktopCloudAccountStore {
    static let shared = DesktopCloudAccountStore(read: readKeychain, write: writeKeychain)
    private let lock = NSLock()
    private var saved: DesktopCloudAccount?
    private let write: (Data?) throws -> Void

    init(read: () -> Data?, write: @escaping (Data?) throws -> Void) {
        self.write = write
        saved = read().flatMap { try? JSONDecoder().decode(DesktopCloudAccount.self, from: $0) }
    }

    func account(baseURL: String, handle: String, now: Date = Date()) -> DesktopCloudAccount? {
        guard let endpoint = CloudPublishCredentials.endpointURL(baseURL: baseURL) else { return nil }
        lock.lock(); defer { lock.unlock() }
        guard let saved, saved.expiresAt.timeIntervalSince(now) > 30,
              saved.accessToken.range(of: "^thd_[a-f0-9]{64}$", options: .regularExpression) != nil,
              let requestedKey = CloudPublishCredentials.storageKey(endpoint: endpoint, handle: handle),
              let savedURL = URL(string: saved.endpoint),
              let savedKey = CloudPublishCredentials.storageKey(endpoint: savedURL, handle: saved.handle),
              requestedKey == savedKey else { return nil }
        return saved
    }

    func canPublish(baseURL: String, handle: String) -> Bool { account(baseURL: baseURL, handle: handle) != nil }

    func save(_ account: DesktopCloudAccount) throws {
        let data = try JSONEncoder().encode(account)
        lock.lock(); defer { lock.unlock() }
        try write(data)
        saved = account
    }

    func invalidate(accessToken: String) {
        lock.lock(); defer { lock.unlock() }
        guard saved?.accessToken == accessToken else { return }
        // Stop using rejected credentials even if a Keychain deletion fails.
        saved = nil
        try? write(nil)
    }

    func clear() throws {
        lock.lock(); defer { lock.unlock() }
        try write(nil)
        saved = nil
    }

    private static let key: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "dev.token-horizon.desktop-publish", kSecAttrAccount as String: "cloud-account"]
    private static func readKeychain() -> Data? {
        var query = key
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }
    private static func writeKeychain(_ data: Data?) throws {
        let status: OSStatus
        if let data {
            let update = SecItemUpdate(key as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            if update == errSecItemNotFound {
                var item = key
                item[kSecValueData as String] = data
                item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                status = SecItemAdd(item as CFDictionary, nil)
            } else { status = update }
        } else {
            let deleted = SecItemDelete(key as CFDictionary)
            status = deleted == errSecItemNotFound ? errSecSuccess : deleted
        }
        guard status == errSecSuccess else {
            throw NSError(domain: "TokenHorizon", code: Int(status), userInfo: [NSLocalizedDescriptionKey:
                "Could not save your connection in Keychain. Unlock your login Keychain and try again."])
        }
    }
}
