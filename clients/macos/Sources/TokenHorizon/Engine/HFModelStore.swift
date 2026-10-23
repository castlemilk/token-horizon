import Foundation

/// The Hugging Face cache, as the bundled engines use it: both engines fetch
/// weights into `~/.cache/huggingface/hub` on first serve, so the cache is the
/// shared "installed models" store — and its partial blobs are the download
/// progress.
///
/// Layout (hub convention):
///
///     hub/models--Qwen--Qwen3-32B-GGUF/
///       blobs/<sha>            complete weights (content-addressed)
///       blobs/<sha>.incomplete partial download, grows as it lands
///       snapshots/<commit>/<file>  symlink → blob
///
/// Nothing here talks to the network: "installed" and "downloading" are
/// observed from the filesystem, which is the ground truth the engines act on.
enum HFModelStore {

    /// `Qwen/Qwen3-32B-GGUF` → `models--Qwen--Qwen3-32B-GGUF`.
    static func cacheDirName(_ repoId: String) -> String {
        "models--" + repoId.replacingOccurrences(of: "/", with: "--")
    }

    static var hubRoot: URL {
        let env = ProcessInfo.processInfo.environment
        if let home = env["HF_HOME"], !home.isEmpty {
            return URL(fileURLWithPath: home).appendingPathComponent("hub")
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".cache/huggingface/hub")
    }

    static func repoDir(_ repoId: String) -> URL {
        hubRoot.appendingPathComponent(cacheDirName(repoId))
    }

    // MARK: - Installed

    /// True when the repo has a complete snapshot on disk (any committed
    /// snapshot with at least one file). A partial download does not count.
    static func isInstalled(_ repoId: String) -> Bool {
        let snapshots = repoDir(repoId).appendingPathComponent("snapshots")
        guard let commits = try? FileManager.default.contentsOfDirectory(atPath: snapshots.path) else { return false }
        for commit in commits {
            let dir = snapshots.appendingPathComponent(commit)
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue {
                if let files = try? FileManager.default.contentsOfDirectory(atPath: dir.path),
                   files.contains(where: { !$0.hasSuffix(".incomplete") }) {
                    return true
                }
            }
        }
        return false
    }

    /// Repo ids under the hub root that have a complete snapshot.
    static func installedModels() -> [String] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: hubRoot.path) else { return [] }
        return names
            .filter { $0.hasPrefix("models--") }
            .map { $0.replacingOccurrences(of: "models--", with: "").replacingOccurrences(of: "--", with: "/") }
            .filter { isInstalled($0) }
            .sorted()
    }

    // MARK: - Download progress

    struct Progress: Equatable {
        let downloadedGB: Double
        let totalGB: Double
        var fraction: Double { totalGB > 0 ? min(1, downloadedGB / totalGB) : 0 }
    }

    /// Download progress for a repo, from the partial blobs the hub writes.
    /// `expectedGB` is the catalogue's measured download size — the hub cannot
    /// know the total until the download completes.
    static func progress(_ repoId: String, expectedGB: Double) -> Progress? {
        let blobs = repoDir(repoId).appendingPathComponent("blobs")
        guard let files = try? FileManager.default.contentsOfDirectory(atPath: blobs.path) else { return nil }
        var partial: Double = 0
        var complete: Double = 0
        for file in files {
            let path = blobs.appendingPathComponent(file)
            let size = (try? FileManager.default.attributesOfItem(atPath: path.path)[.size] as? NSNumber)?.doubleValue ?? 0
            if file.hasSuffix(".incomplete") { partial += size } else { complete += size }
        }
        // A partial download alongside complete shards still counts the shards.
        let downloaded = complete > 0 && partial == 0 ? complete : partial + complete * 0
        let value = partial > 0 ? partial : downloaded
        guard value > 0 else { return nil }
        return Progress(downloadedGB: round(value / 1e9 * 10) / 10,
                        totalGB: expectedGB)
    }
}
