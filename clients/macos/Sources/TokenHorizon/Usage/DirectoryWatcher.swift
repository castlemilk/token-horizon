import CoreServices
import Foundation

/// Recursive per-file change watcher over the provider session roots, built
/// on FSEvents — the kernel-level mechanism Spotlight/Time Machine use:
/// zero idle cost (no polling), coalesced delivery, sub-second latency.
///
/// Delivers `(path, structural)` pairs plus a `forceAll` flag on `queue`.
/// `structural` marks events that can change a directory listing
/// (create/remove/rename) versus pure content appends; `forceAll` marks
/// stream-level drops (kernel/user event overflow, watched-root removal)
/// where the consumer must rescan everything because individual paths may
/// have been lost.
///
/// The stream is (re)created only when `sync(roots:)` sees a changed root
/// set — UsageEngine calls it once per collect with the live provider dirs.
final class DirectoryWatcher {
    typealias Handler = (_ events: [(path: String, structural: Bool)], _ forceAll: Bool) -> Void

    private let handler: Handler
    private let queue = DispatchQueue(label: "tokenhorizon.dirwatch", qos: .utility)
    private var stream: FSEventStreamRef?
    private var roots: [String] = []

    init(handler: @escaping Handler) { self.handler = handler }

    /// Replace the watched root set; restarts the stream only on change.
    /// Non-existent roots are dropped — FSEvents cannot watch them, and the
    /// caller's sweep covers their later creation.
    func sync(roots newRoots: [String]) {
        queue.async { [weak self] in
            guard let self else { return }
            let sorted = Array(Set(newRoots.filter { HomeDiscovery.isDirectory($0) })).sorted()
            guard sorted != self.roots else { return }
            self.roots = sorted
            self.stopStream()
            guard !sorted.isEmpty else { return }

            var ctx = FSEventStreamContext()
            ctx.info = Unmanaged.passUnretained(self).toOpaque()
            let callback: FSEventStreamCallback = { _, info, numEvents, eventPaths, eventFlags, _ in
                guard let info else { return }
                let watcher = Unmanaged<DirectoryWatcher>.fromOpaque(info).takeUnretainedValue()
                guard let paths = unsafeBitCast(eventPaths, to: NSArray.self) as? [String] else { return }
                let structuralMask = UInt32(kFSEventStreamEventFlagItemCreated)
                    | UInt32(kFSEventStreamEventFlagItemRemoved)
                    | UInt32(kFSEventStreamEventFlagItemRenamed)
                let dropMask = UInt32(kFSEventStreamEventFlagMustScanSubDirs)
                    | UInt32(kFSEventStreamEventFlagUserDropped)
                    | UInt32(kFSEventStreamEventFlagKernelDropped)
                    | UInt32(kFSEventStreamEventFlagRootChanged)
                var events: [(path: String, structural: Bool)] = []
                events.reserveCapacity(numEvents)
                var forceAll = false
                for i in 0..<numEvents {
                    let f = eventFlags[i]
                    if f & dropMask != 0 { forceAll = true }
                    guard i < paths.count else { continue }
                    events.append((paths[i], f & structuralMask != 0))
                }
                watcher.handler(events, forceAll)
            }
            let flags = FSEventStreamCreateFlags(kFSEventStreamCreateFlagUseCFTypes)
                | FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents)
                | FSEventStreamCreateFlags(kFSEventStreamCreateFlagWatchRoot)
            guard let s = FSEventStreamCreate(nil, callback, &ctx,
                                              sorted as CFArray,
                                              FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
                                              0.7, flags) else { return }
            FSEventStreamSetDispatchQueue(s, self.queue)
            FSEventStreamStart(s)
            self.stream = s
        }
    }

    private func stopStream() {
        guard let s = stream else { return }
        FSEventStreamStop(s)
        FSEventStreamInvalidate(s)
        FSEventStreamRelease(s)
        stream = nil
    }

    deinit { stopStream() }
}
