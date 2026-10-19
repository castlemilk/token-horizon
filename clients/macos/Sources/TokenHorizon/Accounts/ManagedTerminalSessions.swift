import Foundation
import Darwin

/// Local labels for surfaces launched by Token Horizon. No terminal contents,
/// command output, or authentication material enter this store.
struct ManagedTerminalSession: Codable, Equatable, Identifiable {
    var id: String { terminal.terminalID }
    var terminal: GhosttySession
    var profileID: String
    var action: CLIProfileLaunchAction
    var workingDirectory: String
    var createdAt: Date = Date()
}

final class ManagedTerminalSessionStore {
    static let shared = ManagedTerminalSessionStore()
    private static let maximumFileBytes = 2 * 1024 * 1024
    private static let maximumSessions = 256
    private static let invalidCharacters = CharacterSet.controlCharacters.union(.newlines)
    private let lock = NSLock()
    private let url: URL
    private var payload: Payload
    private(set) var loadError: String?

    private struct Payload: Codable {
        var version = 1
        var workingDirectory: String
        var sessions: [ManagedTerminalSession] = []
    }

    init(directory: URL? = nil, home: String = NSHomeDirectory()) {
        let base = directory ?? URL(fileURLWithPath: home).appendingPathComponent(".config/token-horizon")
        url = base.appendingPathComponent("terminal-sessions.json")
        payload = Payload(workingDirectory: home)
        do {
            guard try Self.isRegularFileIfPresent(url.path) else { return }
            let decoded = try JSONDecoder().decode(Payload.self, from: Self.readBoundedFile(url))
            try Self.validate(decoded)
            payload = decoded
        } catch {
            loadError = "Saved terminal labels could not be read. Repair or move terminal-sessions.json in Token Horizon's settings folder before saving labels. "
                + "The existing file has been preserved."
        }
    }

    func sessions() -> [ManagedTerminalSession] {
        lock.lock(); defer { lock.unlock() }
        return payload.sessions
    }

    func workingDirectory() -> String {
        lock.lock(); defer { lock.unlock() }
        return payload.workingDirectory
    }

    func remember(_ session: ManagedTerminalSession) throws {
        lock.lock(); defer { lock.unlock() }
        try requireWritable()
        try Self.validate(session)
        var next = payload
        next.sessions.removeAll { $0.id == session.id }
        next.sessions.insert(session, at: 0)
        next.sessions = Array(next.sessions.prefix(Self.maximumSessions))
        next.workingDirectory = session.workingDirectory
        try save(next)
    }

    func setWorkingDirectory(_ directory: String) throws {
        lock.lock(); defer { lock.unlock() }
        try requireWritable()
        try Self.validateDirectory(directory)
        var next = payload
        next.workingDirectory = directory
        try save(next)
    }

    /// Prune only after a successful live inventory, never after an error.
    func reconcile(terminalIDs: Set<String>) throws {
        lock.lock(); defer { lock.unlock() }
        try requireWritable()
        guard terminalIDs.allSatisfy(Self.isTerminalID) else {
            throw Self.failure("The terminal inventory contains an invalid identifier. Refresh the terminal list before trying again.")
        }
        let remaining = payload.sessions.filter { terminalIDs.contains($0.id) }
        guard remaining.count != payload.sessions.count else { return }
        var next = payload
        next.sessions = remaining
        try save(next)
    }

    private func save(_ next: Payload) throws {
        try requireWritable()
        try Self.validate(next)
        let temporary = url.deletingLastPathComponent().appendingPathComponent(".terminal-sessions-\(UUID().uuidString).tmp")
        defer { _ = Darwin.unlink(temporary.path) }
        do {
            _ = try Self.isRegularFileIfPresent(url.path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            let data = try JSONEncoder().encode(next)
            guard data.count <= Self.maximumFileBytes else {
                throw Self.failure("Saved terminal labels are too large. Remove unused labels before trying again.")
            }
            let descriptor = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode_t(0o600))
            guard descriptor >= 0 else { throw CocoaError(.fileWriteUnknown) }
            let output = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            defer { try? output.close() }
            guard Darwin.fchmod(descriptor, mode_t(0o600)) == 0 else { throw CocoaError(.fileWriteNoPermission) }
            try output.write(contentsOf: data)
            try output.synchronize()
            try output.close()
            guard Darwin.rename(temporary.path, url.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
            payload = next
        } catch {
            throw Self.failure("Terminal labels could not be saved. Check that Token Horizon's settings folder is writable and terminal-sessions.json is a regular file.")
        }
    }

    private func requireWritable() throws {
        if let loadError { throw Self.failure(loadError) }
    }

    /// A symlink, FIFO or directory must never be treated as an absent store.
    private static func isRegularFileIfPresent(_ path: String) throws -> Bool {
        var info = stat()
        guard Darwin.lstat(path, &info) == 0 else {
            if errno == ENOENT { return false }
            throw CocoaError(.fileReadUnknown)
        }
        guard info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else { throw CocoaError(.fileReadCorruptFile) }
        return true
    }

    /// Both the descriptor and the read itself are bounded. O_NOFOLLOW also
    /// prevents a symlink swapped in after lstat from redirecting the read.
    private static func readBoundedFile(_ url: URL) throws -> Data {
        let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { throw CocoaError(.fileReadUnknown) }
        let input = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? input.close() }
        var info = stat()
        guard Darwin.fstat(descriptor, &info) == 0,
              info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              info.st_size >= 0, info.st_size <= off_t(maximumFileBytes) else { throw CocoaError(.fileReadCorruptFile) }
        var result = Data()
        while result.count <= maximumFileBytes {
            let chunk = try input.read(upToCount: min(65_536, maximumFileBytes + 1 - result.count)) ?? Data()
            if chunk.isEmpty { return result }
            result.append(chunk)
        }
        throw CocoaError(.fileReadCorruptFile)
    }

    private static func validate(_ payload: Payload) throws {
        guard payload.version == 1, payload.sessions.count <= maximumSessions,
              Set(payload.sessions.map(\.id)).count == payload.sessions.count else {
            throw failure("Saved terminal labels have an unsupported format or too many entries.")
        }
        try validateDirectory(payload.workingDirectory)
        try payload.sessions.forEach { try validate($0) }
    }

    private static func validate(_ session: ManagedTerminalSession) throws {
        guard isTerminalID(session.id), isSurfaceID(session.terminal.windowID), isSurfaceID(session.terminal.tabID),
              isProfileID(session.profileID),
              session.createdAt.timeIntervalSinceReferenceDate.isFinite else {
            throw failure("The terminal label has an invalid account or surface identifier. Launch the account again to create a new label.")
        }
        try validateDirectory(session.workingDirectory)
    }

    private static func isTerminalID(_ value: String) -> Bool {
        value.utf8.count == 36 && UUID(uuidString: value) != nil
    }

    private static func isProfileID(_ value: String) -> Bool {
        value.utf8.count <= 23
            && value.range(of: #"^(claude|codex)-[0-9a-f]{16}$"#, options: .regularExpression) == value.startIndex..<value.endIndex
    }

    private static func isSurfaceID(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 256 && value == value.trimmingCharacters(in: .whitespacesAndNewlines)
            && !value.unicodeScalars.contains { invalidCharacters.contains($0) }
    }

    private static func validateDirectory(_ directory: String) throws {
        guard directory.hasPrefix("/"), directory.utf8.count <= 4096,
              directory == directory.trimmingCharacters(in: .whitespacesAndNewlines),
              !directory.unicodeScalars.contains(where: { invalidCharacters.contains($0) }) else {
            throw failure("Choose an absolute project folder without line breaks or surrounding whitespace.")
        }
    }

    private static func failure(_ message: String) -> NSError {
        NSError(domain: "TokenHorizon.Terminals", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
