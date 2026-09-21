import SwiftUI
import WidgetKit

struct HorizonEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot
    var offline = false
    var page = 0
    var window = WidgetWindow.days.rawValue
}

struct HorizonProvider: TimelineProvider {
    private var cacheURL: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("token-horizon-widget.json")
    }

    func placeholder(in context: Context) -> HorizonEntry {
        HorizonEntry(date: Date(), snapshot: .preview)
    }

    func getSnapshot(in context: Context, completion: @escaping (HorizonEntry) -> Void) {
        if context.isPreview { completion(placeholder(in: context)) } else { load(completion) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<HorizonEntry>) -> Void) {
        load { entry in
            let stale = HorizonEntry(date: Date().addingTimeInterval(901), snapshot: entry.snapshot, offline: entry.offline)
            completion(Timeline(entries: [entry, stale], policy: .after(Date().addingTimeInterval(300))))
        }
    }

    private func load(_ completion: @escaping (HorizonEntry) -> Void) {
        guard let url = URL(string: "http://127.0.0.1:8765/widget") else {
            completion(HorizonEntry(date: Date(), snapshot: WidgetSnapshot(), offline: true))
            return
        }
        // WidgetKit renders only after this completion, so the timeout is a
        // paint deadline: keep it tight and fall back to the cached snapshot
        // fast when the host app is momentarily busy.
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 1.5)
        request.httpMethod = "GET"
        let started = Date()
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let elapsed = Date().timeIntervalSince(started)
            if let data, data.count <= 65_536, (response as? HTTPURLResponse)?.statusCode == 200,
               let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data),
               snapshot.version == WidgetSnapshot.schemaVersion {
                try? FileManager.default.createDirectory(at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? data.write(to: cacheURL, options: .atomic)
                NSLog("[TokenHorizonWidget] timeline fetch ok in %.0fms (%d bytes)", elapsed * 1000, data.count)
                completion(HorizonEntry(date: Date(), snapshot: snapshot,
                                        page: snapshot.preferences.page,
                                        window: snapshot.preferences.window))
            } else {
                let cached = (try? Data(contentsOf: cacheURL)).flatMap {
                    try? JSONDecoder().decode(WidgetSnapshot.self, from: $0)
                }
                let snapshot = cached?.version == WidgetSnapshot.schemaVersion ? cached : nil
                NSLog("[TokenHorizonWidget] timeline fetch failed after %.0fms — cached=%@",
                      elapsed * 1000, snapshot == nil ? "none" : "yes")
                completion(HorizonEntry(date: Date(), snapshot: snapshot ?? WidgetSnapshot(),
                                        offline: true,
                                        page: (snapshot ?? WidgetSnapshot()).preferences.page,
                                        window: (snapshot ?? WidgetSnapshot()).preferences.window))
            }
        }.resume()
    }
}

struct HorizonWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: HorizonEntry

    var body: some View {
        WidgetCard(snapshot: entry.snapshot,
                   size: family == .systemSmall ? "small" : family == .systemLarge ? "large" : "medium",
                   date: entry.date, offline: entry.offline, page: entry.page, window: entry.window)
            .containerBackground(.fill.tertiary, for: .widget)
            .widgetURL(URL(string: "tokenhorizon://dashboard"))
    }
}

@main
struct TokenHorizonWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetSnapshot.kind, provider: HorizonProvider()) { entry in
            HorizonWidgetView(entry: entry)
        }
        .configurationDisplayName("Token Horizon")
        .description("Token usage and plan limits. Configure in Token Horizon Settings. Updates are scheduled by macOS.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
