import Foundation
import CryptoKit
import Darwin

enum CLIAccountProvider: String, Codable, CaseIterable, Identifiable {
    case claude
    case codex

    var id: String { rawValue }
    var title: String { self == .claude ? "Claude Code" : "Codex" }
    var executable: String { rawValue }
    var environmentKey: String { self == .claude ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME" }
    var defaultHomePrefix: String { self == .claude ? ".claude" : ".codex" }
}

/// User-facing profile metadata only. Tokens remain in the CLI's own stores.
struct ManagedCLIProfile: Codable, Identifiable, Equatable {
    var id: String
    var provider: CLIAccountProvider
    var name: String
    var configDir: String
    var expectedEmail: String
    var workingDirectory: String?
    var createdByApp: Bool
    var isHidden: Bool

    init(id: String? = nil, provider: CLIAccountProvider, name: String, configDir: String,
         expectedEmail: String = "", workingDirectory: String? = nil, createdByApp: Bool = false,
         isHidden: Bool = false) {
        self.id = id ?? ManagedCLIProfileStore.profileID(provider: provider, configDir: configDir)
        self.provider = provider
        self.name = name
        self.configDir = configDir
        self.expectedEmail = expectedEmail
        self.workingDirectory = workingDirectory
        self.createdByApp = createdByApp
        self.isHidden = isHidden
    }

    private enum CodingKeys: String, CodingKey {
        case id, provider, name, configDir, expectedEmail, workingDirectory, createdByApp, isHidden
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        provider = try values.decode(CLIAccountProvider.self, forKey: .provider)
        name = try values.decode(String.self, forKey: .name)
        configDir = try values.decode(String.self, forKey: .configDir)
        expectedEmail = try values.decode(String.self, forKey: .expectedEmail)
        workingDirectory = try values.decodeIfPresent(String.self, forKey: .workingDirectory)
        createdByApp = try values.decode(Bool.self, forKey: .createdByApp)
        isHidden = try values.decodeIfPresent(Bool.self, forKey: .isHidden) ?? false
    }
}

enum ManagedCLIProfileError: LocalizedError {
    case invalidInput(String)
    case registryUnavailable(String)
    case persistenceFailed

    var errorDescription: String? {
        switch self {
        case .invalidInput(let message), .registryUnavailable(let message): return message
        case .persistenceFailed: return "The account list could not be saved. Check that its settings folder is writable."
        }
    }
}

/// A locked, non-secret registry. Forgetting a profile never removes CLI data.
final class ManagedCLIProfileStore {
    static let shared = ManagedCLIProfileStore()
    private static let codexConfiguration = Data("cli_auth_credentials_store = \"file\"\n".utf8)
    private let lock = NSLock()
    private let home: String
    private let registryURL: URL
    private var entries: [ManagedCLIProfile] = []
    private var defaults: [String: String] = [:]
    let loadError: String?

    private struct Registry: Codable {
        var version = 1
        var profiles: [ManagedCLIProfile]
        var defaultProfileIDs: [String: String]
    }

    init(directory: URL? = nil, home: String = NSHomeDirectory()) {
        self.home = Self.normalizedPath(home)
        registryURL = (directory ?? URL(fileURLWithPath: self.home)
            .appendingPathComponent(".config/token-horizon", isDirectory: true))
            .appendingPathComponent("accounts.json")
        var registryInfo = stat()
        guard Darwin.lstat(registryURL.path, &registryInfo) == 0 else {
            loadError = errno == ENOENT ? nil : "The saved account list could not be read. Check its settings folder before saving changes."
            return
        }
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: registryURL.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular,
                  let bytes = attributes[.size] as? NSNumber, bytes.intValue <= 1_048_576 else {
                throw ManagedCLIProfileError.invalidInput("The account list is too large.")
            }
            let registry = try JSONDecoder().decode(Registry.self, from: Data(contentsOf: registryURL))
            guard registry.version == 1, registry.profiles.count <= 256 else {
                throw ManagedCLIProfileError.invalidInput("The account list has an unsupported format.")
            }
            var ids = Set<String>()
            for profile in registry.profiles {
                let validated = try Self.validated(profile, home: self.home)
                guard validated == profile, ids.insert(profile.id).inserted else {
                    throw ManagedCLIProfileError.invalidInput("The account list contains invalid or duplicate profiles.")
                }
            }
            entries = registry.profiles
            defaults = registry.defaultProfileIDs.filter { provider, id in
                registry.profiles.contains { $0.provider.rawValue == provider && $0.id == id }
            }
            loadError = nil
        } catch {
            loadError = "The saved account list could not be read. Repair or move \(Self.displayPath(registryURL.path)) before saving changes."
        }
    }

    func profiles() -> [ManagedCLIProfile] {
        lock.lock(); defer { lock.unlock() }
        return entries.sorted {
            if $0.provider != $1.provider { return $0.provider.rawValue < $1.provider.rawValue }
            let comparison = $0.name.localizedStandardCompare($1.name)
            return comparison == .orderedSame ? $0.configDir < $1.configDir : comparison == .orderedAscending
        }
    }

    func profilePaths(for provider: CLIAccountProvider) -> [String] {
        profiles().filter { $0.provider == provider }.map(\.configDir)
    }

    func defaultProfileID(for provider: CLIAccountProvider) -> String? {
        lock.lock(); defer { lock.unlock() }
        return defaults[provider.rawValue]
    }

    func setDefault(profileID: String, provider: CLIAccountProvider) throws {
        lock.lock(); defer { lock.unlock() }
        try requireWritable()
        guard entries.contains(where: { $0.id == profileID && $0.provider == provider }) else {
            throw ManagedCLIProfileError.invalidInput("Choose a saved \(provider.title) account before making it the default.")
        }
        var updated = defaults
        updated[provider.rawValue] = profileID
        try persist(profiles: entries, defaults: updated)
        defaults = updated
    }

    func save(_ profile: ManagedCLIProfile) throws {
        lock.lock(); defer { lock.unlock() }
        try requireWritable()
        let validated = try Self.validated(profile, home: home)
        try saveLocked(validated)
    }

    func setHidden(profileID: String, hidden: Bool) throws {
        lock.lock(); defer { lock.unlock() }
        try requireWritable()
        guard var profile = entries.first(where: { $0.id == profileID }) else {
            throw ManagedCLIProfileError.invalidInput("Save this account before changing its visibility.")
        }
        profile.isHidden = hidden
        try saveLocked(profile)
    }

    func create(provider: CLIAccountProvider, name: String, expectedEmail: String = "",
                workingDirectory: String? = nil) throws -> ManagedCLIProfile {
        lock.lock(); defer { lock.unlock() }
        try requireWritable()
        let cleanName = try Self.validatedName(name)
        let slug = cleanName.folding(options: [.diacriticInsensitive, .widthInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }.joined(separator: "-")
        guard !slug.isEmpty, slug.utf8.count <= 120 else {
            throw ManagedCLIProfileError.invalidInput("Use a shorter account name containing a letter or number.")
        }
        let dir = "\(home)/\(provider.defaultHomePrefix)-\(slug)"
        let profile = try Self.validated(ManagedCLIProfile(
            provider: provider, name: cleanName, configDir: dir, expectedEmail: expectedEmail,
            workingDirectory: workingDirectory, createdByApp: true), home: home)
        if FileManager.default.fileExists(atPath: dir) {
            throw ManagedCLIProfileError.invalidInput("A profile folder already exists at \(Self.displayPath(dir)). Choose another name or import it.")
        }
        guard Darwin.mkdir(dir, mode_t(0o700)) == 0 else {
            throw ManagedCLIProfileError.invalidInput("The profile folder could not be created at \(Self.displayPath(dir)).")
        }
        let configURL = URL(fileURLWithPath: dir).appendingPathComponent("config.toml")
        do {
            if provider == .codex {
                guard FileManager.default.createFile(atPath: configURL.path, contents: Self.codexConfiguration,
                                                     attributes: [.posixPermissions: 0o600]) else {
                    throw ManagedCLIProfileError.invalidInput("The Codex profile configuration could not be created.")
                }
            }
            try saveLocked(profile)
            return profile
        } catch {
            // Roll back only the file we seeded and an empty folder. Never
            // remove credentials or other files a CLI may have written.
            if provider == .codex, (try? Data(contentsOf: configURL)) == Self.codexConfiguration {
                _ = Darwin.unlink(configURL.path)
            }
            _ = Darwin.rmdir(dir)
            throw error
        }
    }

    func importProfile(provider: CLIAccountProvider, path: String, name: String, expectedEmail: String = "",
                       workingDirectory: String? = nil) throws -> ManagedCLIProfile {
        let dir = try Self.validatedPath(path, home: home)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: dir, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw ManagedCLIProfileError.invalidInput("Choose an existing profile folder.")
        }
        let profile = try Self.validated(ManagedCLIProfile(
            provider: provider, name: name, configDir: dir, expectedEmail: expectedEmail,
            workingDirectory: workingDirectory), home: home)
        try save(profile)
        return profile
    }

    func remove(profileID: String) throws {
        lock.lock(); defer { lock.unlock() }
        try requireWritable()
        let updated = entries.filter { $0.id != profileID }
        let updatedDefaults = defaults.filter { $0.value != profileID }
        try persist(profiles: updated, defaults: updatedDefaults)
        entries = updated
        defaults = updatedDefaults
    }

    static func profileID(provider: CLIAccountProvider, configDir: String) -> String {
        let bytes = Data(normalizedPath(configDir).utf8)
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        return "\(provider.rawValue)-\(digest.prefix(16))"
    }

    static func normalizedPath(_ path: String, home: String = NSHomeDirectory()) -> String {
        guard !path.isEmpty else { return "" }
        let expanded = path == "~" ? home : path.hasPrefix("~/") ? home + String(path.dropFirst()) : path
        return URL(fileURLWithPath: expanded).standardizedFileURL.path
    }

    private func requireWritable() throws {
        if let loadError { throw ManagedCLIProfileError.registryUnavailable(loadError) }
    }

    private func saveLocked(_ profile: ManagedCLIProfile) throws {
        var updated = entries
        if let index = updated.firstIndex(where: { $0.id == profile.id }) {
            var retained = profile
            retained.createdByApp = retained.createdByApp || updated[index].createdByApp
            updated[index] = retained
        } else {
            guard updated.count < 256 else {
                throw ManagedCLIProfileError.invalidInput("The account list is full. Remove an unused saved profile first.")
            }
            updated.append(profile)
        }
        try persist(profiles: updated, defaults: defaults)
        entries = updated
    }

    private func persist(profiles: [ManagedCLIProfile], defaults: [String: String]) throws {
        let directory = registryURL.deletingLastPathComponent()
        let temporary = directory.appendingPathComponent(".accounts-\(UUID().uuidString).tmp")
        defer { try? FileManager.default.removeItem(at: temporary) }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(Registry(profiles: profiles, defaultProfileIDs: defaults))
            guard FileManager.default.createFile(atPath: temporary.path, contents: data,
                                                 attributes: [.posixPermissions: 0o600]),
                  Darwin.rename(temporary.path, registryURL.path) == 0 else {
                throw ManagedCLIProfileError.persistenceFailed
            }
        } catch {
            throw ManagedCLIProfileError.persistenceFailed
        }
    }

    private static func validated(_ profile: ManagedCLIProfile, home: String) throws -> ManagedCLIProfile {
        var profile = profile
        profile.configDir = try validatedPath(profile.configDir, home: home)
        guard profile.id == profileID(provider: profile.provider, configDir: profile.configDir) else {
            throw ManagedCLIProfileError.invalidInput("The account identifier does not match its profile folder.")
        }
        profile.name = try validatedName(profile.name)
        let email = profile.expectedEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        let emailParts = email.split(separator: "@", omittingEmptySubsequences: false)
        guard email.count <= 254, !email.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.union(.controlCharacters).contains($0) }),
              email.isEmpty || (emailParts.count == 2 && emailParts.allSatisfy { !$0.isEmpty }) else {
            throw ManagedCLIProfileError.invalidInput("Enter a valid expected email address, or leave it empty.")
        }
        profile.expectedEmail = email
        if let workingDirectory = profile.workingDirectory {
            profile.workingDirectory = try validatedPath(workingDirectory, home: home, allowHome: true)
        }
        return profile
    }

    private static func validatedName(_ name: String) throws -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 80, trimmed != ".", trimmed != "..",
              !trimmed.contains("/"), !trimmed.contains("\\"),
              !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw ManagedCLIProfileError.invalidInput("Use an account name of 1–80 characters without slashes or line breaks.")
        }
        return trimmed
    }

    private static func validatedPath(_ path: String, home: String, allowHome: Bool = false) throws -> String {
        guard !path.isEmpty, path.utf8.count <= 4096,
              path == path.trimmingCharacters(in: .whitespacesAndNewlines),
              path.hasPrefix("/") || path.hasPrefix("~/"),
              !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw ManagedCLIProfileError.invalidInput("Choose an absolute folder path without line breaks or surrounding whitespace.")
        }
        let normalized = normalizedPath(path, home: home)
        guard normalized != "/", allowHome || normalized != home else {
            throw ManagedCLIProfileError.invalidInput("Choose a dedicated profile folder instead of the filesystem root or your home folder.")
        }
        return normalized
    }

    private static func displayPath(_ path: String) -> String {
        path.count <= 160 ? path : "…" + String(path.suffix(159))
    }
}
