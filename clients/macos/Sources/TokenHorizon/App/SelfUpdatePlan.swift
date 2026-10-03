import Foundation

struct SelfUpdateFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct SelfUpdateRelease: Equatable {
    let tag: String
    let version: String
    let archive: URL
    let checksum: URL
    let archiveSize: Int64
    let checksumSize: Int64
    let archiveDigest: String?
    var archiveName: String { archive.lastPathComponent }
}

/// The stable native release contract is deliberately separate from Electron
/// artifacts published in the same repository.
enum SelfUpdatePlan {
    static let repository = "castlemilk/token-horizon"
    static let maximumArchiveSize: Int64 = 1_073_741_824
    static let maximumChecksumSize: Int64 = 65_536

    static func versionParts(_ value: String) -> [Int]? {
        guard value.range(of: #"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"#,
                          options: .regularExpression) != nil else { return nil }
        let parts = value.split(separator: ".").compactMap { Int($0) }
        return parts.count == 3 ? parts : nil
    }

    static func isNewer(_ candidate: String, than current: String) -> Bool {
        guard let candidate = versionParts(candidate), let current = versionParts(current) else { return false }
        for (a, b) in zip(candidate, current) where a != b { return a > b }
        return false
    }

    static func release(_ object: [String: Any]) throws -> SelfUpdateRelease {
        guard object["draft"] as? Bool == false, object["prerelease"] as? Bool == false,
              let tag = object["tag_name"] as? String, tag.hasPrefix("v"),
              versionParts(String(tag.dropFirst())) != nil,
              let assets = object["assets"] as? [[String: Any]] else {
            throw SelfUpdateFailure("The release is not a stable native macOS release.")
        }
        let version = String(tag.dropFirst())
        let archiveName = "TokenHorizon-\(version).zip", checksumName = "TokenHorizon-\(version).sha256"
        func asset(_ name: String, maximum: Int64) throws -> (URL, Int64, String?) {
            let matches = assets.filter { $0["name"] as? String == name }
            guard matches.count == 1, let item = matches.first, item["state"] as? String == "uploaded",
                  let raw = item["browser_download_url"] as? String, let url = URL(string: raw),
                  url.scheme == "https", url.host == "github.com", url.user == nil, url.password == nil,
                  url.port == nil, url.query == nil, url.fragment == nil,
                  url.path == "/\(repository)/releases/download/\(tag)/\(name)",
                  let size = item["size"] as? NSNumber, size.int64Value > 0, size.int64Value <= maximum else {
                throw SelfUpdateFailure("This release does not include a complete native macOS archive and checksum.")
            }
            var digest: String?
            if let rawDigest = item["digest"] as? String {
                guard rawDigest.range(of: #"^sha256:[a-fA-F0-9]{64}$"#, options: .regularExpression) != nil else {
                    throw SelfUpdateFailure("The release asset has an invalid SHA-256 digest.")
                }
                digest = String(rawDigest.dropFirst(7)).lowercased()
            }
            return (url, size.int64Value, digest)
        }
        let archive = try asset(archiveName, maximum: maximumArchiveSize)
        let checksum = try asset(checksumName, maximum: maximumChecksumSize)
        return SelfUpdateRelease(tag: tag, version: version, archive: archive.0, checksum: checksum.0,
                                 archiveSize: archive.1, checksumSize: checksum.1, archiveDigest: archive.2)
    }

    static func newestNativeRelease(_ objects: [[String: Any]]) -> SelfUpdateRelease? {
        objects.compactMap { try? release($0) }.max { isNewer($1.version, than: $0.version) }
    }

    static func checksum(_ text: String, archiveName: String) throws -> String {
        guard text.utf8.count <= maximumChecksumSize else {
            throw SelfUpdateFailure("The release checksum file is too large.")
        }
        var matches: [String] = []
        for line in text.split(whereSeparator: \.isNewline) {
            let fields = line.split(maxSplits: 1, whereSeparator: { $0 == " " || $0 == "\t" })
            guard fields.count == 2 else { continue }
            let name = fields[1].trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"^\*"#, with: "", options: .regularExpression)
            guard name == archiveName else { continue }
            let digest = String(fields[0])
            guard digest.range(of: #"^[a-fA-F0-9]{64}$"#, options: .regularExpression) != nil else {
                throw SelfUpdateFailure("The release archive checksum is invalid.")
            }
            matches.append(digest.lowercased())
        }
        guard matches.count == 1 else {
            throw SelfUpdateFailure("The release checksum does not identify this native archive exactly once.")
        }
        return matches[0]
    }

    static func trustedDownloadURL(_ url: URL) -> Bool {
        guard url.scheme == "https", url.user == nil, url.password == nil, url.port == nil else { return false }
        return ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].contains(url.host ?? "")
    }

    static func validateArchivePaths(_ listing: String) throws {
        let paths = listing.split(whereSeparator: \.isNewline)
        guard !paths.isEmpty, paths.count <= 100_000,
              paths.allSatisfy({ path in
                  !path.hasPrefix("/") && !path.contains("\\")
                    && !path.split(separator: "/").contains("..")
                    && (path == "TokenHorizon.app/" || path.hasPrefix("TokenHorizon.app/") || path == "__MACOSX/"
                        || path.hasPrefix("__MACOSX/TokenHorizon.app/"))
              }) else { throw SelfUpdateFailure("The release archive contains unexpected paths.") }
    }

    static func validateBundleMetadata(_ metadata: [String: Any], version: String) throws -> String {
        guard metadata["CFBundleIdentifier"] as? String == "local.benebsworth.token-horizon",
              metadata["CFBundleExecutable"] as? String == "TokenHorizon",
              metadata["CFBundlePackageType"] as? String == "APPL",
              metadata["CFBundleShortVersionString"] as? String == version,
              let commit = metadata["THGitSHA"] as? String, isCleanReleaseCommit(commit) else {
            throw SelfUpdateFailure("The downloaded app does not match the expected release identity and version.")
        }
        return commit
    }

    static func isCleanReleaseCommit(_ value: String) -> Bool {
        guard let range = value.range(of: #"^[a-fA-F0-9]{7,40}$"#, options: .regularExpression) else { return false }
        return range.lowerBound == value.startIndex && range.upperBound == value.endIndex
    }

    static func automaticInstallAllowed(commit: String, version: String, failedVersion: String?) -> Bool {
        isCleanReleaseCommit(commit) && version != failedVersion
    }

    static func matchingLaunchAgent(_ plist: [String: Any], bundle: URL) -> Bool {
        guard plist["Label"] as? String == LaunchAgentCtl.label,
              let arguments = plist["ProgramArguments"] as? [String], let executable = arguments.first else { return false }
        return URL(fileURLWithPath: executable).standardizedFileURL
            == bundle.appendingPathComponent("Contents/MacOS/TokenHorizon").standardizedFileURL
    }
}

/// All paths are siblings on one filesystem; committing a prepared copy uses
/// renames rather than copying over the running app. Injected operations let
/// tests prove restoration when a rename fails or leaves a partial destination.
enum SelfUpdateTransaction {
    static func replace(prepared: URL, destination: URL, backup: URL, previousBackup: URL,
                        exists: (URL) -> Bool, move: (URL, URL) throws -> Void,
                        remove: (URL) throws -> Void) throws {
        var previousMoved = false, currentMoved = false
        do {
            if exists(backup) { try move(backup, previousBackup); previousMoved = true }
            try move(destination, backup); currentMoved = true
            try move(prepared, destination)
        } catch {
            do {
                if currentMoved {
                    if exists(destination) { try remove(destination) }
                    try move(backup, destination)
                }
                if previousMoved { try move(previousBackup, backup) }
            } catch let rollback {
                throw SelfUpdateFailure("Could not restore the previous app: \(rollback.localizedDescription). The recovery copy remains at \(backup.path).")
            }
            throw error
        }
        if previousMoved { try? remove(previousBackup) }
    }

    static func restore(destination: URL, backup: URL, failedCopy: URL,
                        move: (URL, URL) throws -> Void) throws {
        try move(destination, failedCopy)
        do { try move(backup, destination) }
        catch {
            try? move(failedCopy, destination)
            throw SelfUpdateFailure("Could not restore the previous app. Recovery copies remain at \(backup.path) and \(failedCopy.path).")
        }
    }
}

enum SelfUpdateRelaunch {
    /// All mutable values are positional arguments, including paths containing
    /// quotes, spaces, dollar signs or backticks. Never interpolate into shell.
    static func arguments(pid: Int32, app: URL, backup: URL, failedCopy: URL,
                          service: String, version: String, commit: String, report: URL) -> [String] {
        ["-c", script, "token-horizon-update", String(pid), app.path, backup.path,
         failedCopy.path, service, version, commit, report.path]
    }

    static let script = #"""
    pid="$1"; app="$2"; backup="$3"; failed="$4"; service="$5"; version="$6"; commit="$7"; report="$8"
    count=0
    while /bin/kill -0 "$pid" 2>/dev/null && [ "$count" -lt 150 ]; do
      /bin/sleep 0.2
      count=$((count + 1))
    done
    if /bin/kill -0 "$pid" 2>/dev/null; then
      /usr/bin/printf '%s\n%s\n' "$version" 'The update is installed, but Token Horizon did not exit. Restart the app to finish.' > "$report"
      exit 1
    fi
    launch() {
      if [ -n "$service" ]; then
        /bin/launchctl kickstart -k "$service" && return 0
      fi
      /usr/bin/open -n "$app"
    }
    healthy() {
      payload=$(/usr/bin/curl -fsS --max-time 1 http://127.0.0.1:8765/health 2>/dev/null) || return 1
      actual_version=$(/usr/bin/printf '%s' "$payload" | /usr/bin/plutil -extract build.version raw -o - - 2>/dev/null) || return 1
      actual_commit=$(/usr/bin/printf '%s' "$payload" | /usr/bin/plutil -extract build.commit raw -o - - 2>/dev/null) || return 1
      [ "$actual_version" = "$version" ] && [ "$actual_commit" = "$commit" ]
    }
    if launch; then
      count=0
      while [ "$count" -lt 30 ]; do
        if healthy; then /bin/rm -f "$report"; exit 0; fi
        /bin/sleep 1
        count=$((count + 1))
      done
    fi
    /usr/bin/printf '%s\n%s\n' "$version" 'The new version did not start correctly. Your previous version was restored; automatic retry is paused for this release.' > "$report"
    if /bin/mv "$app" "$failed"; then
      if /bin/mv "$backup" "$app"; then
        launch
      else
        /bin/mv "$failed" "$app"
        /usr/bin/printf '%s\n%s\n' "$version" 'Update recovery failed. Restore the backup app beside this installation before retrying.' > "$report"
      fi
    fi
    exit 1
    """#
}
