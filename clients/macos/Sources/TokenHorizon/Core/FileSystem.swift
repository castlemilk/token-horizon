import Foundation

/// Injectable file-read surface.
///
/// Go analogue: accept `io.Reader`-style interfaces so parsers can be tested
/// with in-memory data instead of hitting the real filesystem. `UsageEngine`'s
/// JSONL scanners currently read via `FileManager`/`Data(contentsOf:)`
/// directly; new parsing code should take a `THFileReading` so tests can pass
/// `InMemoryFileSystem`. Kept deliberately narrow (2 methods) — widen only
/// when a second consumer needs it.
protocol THFileReading {
    func contents(atPath path: String) -> Data?
    func fileExists(atPath path: String) -> Bool
}

/// Production implementation backed by `FileManager`.
struct LiveFileSystem: THFileReading {
    func contents(atPath path: String) -> Data? {
        FileManager.default.contents(atPath: path)
    }

    func fileExists(atPath path: String) -> Bool {
        FileManager.default.fileExists(atPath: path)
    }
}

/// In-memory fake for tests. Seed via the initializer or `write(_:to:)`.
final class InMemoryFileSystem: THFileReading {
    private var files: [String: Data]
    private let lock = NSLock()

    init(files: [String: Data] = [:]) {
        self.files = files
    }

    func contents(atPath path: String) -> Data? {
        lock.lock(); defer { lock.unlock() }
        return files[path]
    }

    func fileExists(atPath path: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return files[path] != nil
    }

    func write(_ data: Data, to path: String) {
        lock.lock(); defer { lock.unlock() }
        files[path] = data
    }

    func remove(atPath path: String) {
        lock.lock(); defer { lock.unlock() }
        files.removeValue(forKey: path)
    }
}
