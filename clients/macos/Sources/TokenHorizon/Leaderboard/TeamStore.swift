import Combine
import Foundation

/// Where the current team rows came from. `.local` means the cloud was
/// unreachable and the rows were grouped from the entries already on disk.
enum TeamSource: String {
    case cloud
    case local
    case none
}

struct LeaderboardTeamMember: Equatable {
    var handle: String
    var tokensAll: Int
    var avatarUrl: String = ""
    var avatarStyle: String = ""
}

struct LeaderboardTeamDay: Equatable {
    /// Epoch seconds at the start of the day (same unit the worker publishes).
    var day: Int
    var tokens: Int
}

/// One aggregated team row, mirroring `aggregateTeams` (+ the optional
/// enrichment from `enrichTeamAggregates`) in `cloudflare/src/index.js` so the
/// native tab and the web Teams view render the same numbers.
struct LeaderboardTeam: Equatable, Identifiable {
    var team: String
    var teamId: String = ""
    var tokens: Int = 0
    var tokensToday: Int = 0
    var tokens7d: Int = 0
    /// Profiles that actually published a value for that window; unpublished
    /// members contribute no usage and are never counted as zero activity.
    var publishedToday: Int = 0
    var publishedWeek: Int = 0
    var cost: Double = 0
    /// Published profiles in this row (not the roster size).
    var members: Int = 0
    var providers: [String: Double] = [:]
    var users: [LeaderboardTeamMember] = []
    var daily: [LeaderboardTeamDay] = []
    /// Roster size — only ever present when the cloud supplied it. An unknown
    /// roster total must never be guessed, so this stays nil otherwise.
    var memberCount: Int? = nil
    var logoUrl: String? = nil
    var teamUrl: String? = nil

    var id: String { teamId.isEmpty ? "legacy:\(team)" : "id:\(teamId)" }

    var tokensFormatted: String { UsageSnapshot.tokens(tokens) }
    var costFormatted: String { UsageSnapshot.cost(cost) }

    var providerMix: [(provider: String, tokens: Double)] {
        providers.sorted { $0.value > $1.value }.map { (provider: $0.key, tokens: $0.value) }
    }

    func score(for period: LeaderboardPeriod) -> Int {
        switch period {
        case .today: return tokensToday
        case .week: return tokens7d
        case .all: return tokens
        case .streak: return tokens
        }
    }

    func scoreFormatted(for period: LeaderboardPeriod) -> String {
        UsageSnapshot.tokens(score(for: period))
    }

    init(team: String) { self.team = team }

    static func number(_ value: Any?) -> Double {
        if let n = value as? NSNumber { return n.doubleValue }
        return 0
    }

    static func integer(_ value: Any?) -> Int {
        if let n = value as? NSNumber { return n.intValue }
        return 0
    }

    /// Parse a row out of the `GET /api/teams` payload (or a dict built by
    /// `TeamStore.localTeams`).
    init?(dict: [String: Any]) {
        guard let team = dict["team"] as? String, !team.isEmpty else { return nil }
        self.team = team
        teamId = dict["teamId"] as? String ?? ""
        tokens = Self.integer(dict["tokens"])
        tokensToday = Self.integer(dict["tokensToday"])
        tokens7d = Self.integer(dict["tokens7d"])
        cost = Self.number(dict["cost"])
        members = Self.integer(dict["members"])
        publishedToday = ((dict["recentWindowProfiles"] as? [String: Any])?["today"]).map(Self.integer) ?? 0
        publishedWeek = ((dict["recentWindowProfiles"] as? [String: Any])?["week"]).map(Self.integer) ?? 0
        if let raw = dict["providers"] as? [String: Any] {
            var out: [String: Double] = [:]
            for (key, value) in raw { out[key] = Self.number(value) }
            providers = out
        }
        if let raw = dict["users"] as? [[String: Any]] {
            users = raw.compactMap { row in
                guard let handle = row["handle"] as? String, !handle.isEmpty else { return nil }
                return LeaderboardTeamMember(handle: handle,
                                              tokensAll: Self.integer(row["tokensAll"]),
                                              avatarUrl: row["avatarUrl"] as? String ?? "",
                                              avatarStyle: row["avatarStyle"] as? String ?? "")
            }
        }
        if let raw = dict["daily"] as? [[String: Any]] {
            daily = raw.map { LeaderboardTeamDay(day: Self.integer($0["day"]),
                                                 tokens: Self.integer($0["tokens"])) }
                .sorted { $0.day < $1.day }
        }
        memberCount = dict["memberCount"].map(Self.integer)
        logoUrl = dict["logoUrl"] as? String
        teamUrl = dict["url"] as? String
    }

    /// Wire shape for `GET /teams`, matching `aggregateTeams` output.
    func toDict() -> [String: Any] {
        var out: [String: Any] = [
            "team": team,
            "tokens": tokens,
            "tokensToday": tokensToday,
            "tokens7d": tokens7d,
            "cost": cost,
            "members": members,
            "recentWindowProfiles": ["today": publishedToday, "week": publishedWeek],
            "providers": providers,
            "users": users.map { ["handle": $0.handle, "tokensAll": $0.tokensAll,
                                  "avatarUrl": $0.avatarUrl, "avatarStyle": $0.avatarStyle] },
            "daily": daily.map { ["day": $0.day, "tokens": $0.tokens] },
            "tokensFormatted": tokensFormatted,
            "costFormatted": costFormatted
        ]
        out["teamId"] = teamId
        if let memberCount { out["memberCount"] = memberCount; out["publishedProfiles"] = members }
        if let logoUrl { out["logoUrl"] = logoUrl }
        if let teamUrl { out["url"] = teamUrl }
        return out
    }
}

/// Team rows for the TEAMS tab: cloud-first (`GET /api/teams`) with an
/// on-device grouping of the local leaderboard entries as the fallback.
///
/// Storage is guarded by `lock` so the loopback server and MCP can read
/// `snapshot()` from any queue; `@Published` mirrors are only ever written on
/// the main queue.
final class TeamStore: ObservableObject {
    static let shared = TeamStore()
    /// Mirrors the worker's `max-age=15, s-maxage=30` but stays conservative:
    /// a tab switch should not re-hit the cloud every time.
    static let staleAfter: TimeInterval = 60

    @Published private(set) var teams: [LeaderboardTeam] = []
    @Published private(set) var source: TeamSource = .none
    @Published private(set) var lastFetchAt: Date?
    @Published private(set) var lastError: String?

    private let lock = NSLock()
    private var cachedTeams: [LeaderboardTeam] = []
    private var cachedSource: TeamSource = .none
    private var cachedAt: Date?
    private var cachedError: String?
    private var etag: String?
    private var inFlight = false

    private init() {
        // Seed from the entries on disk so the tab is never blank while the
        // first cloud fetch is still in flight.
        let seeded = Self.localTeams(from: LeaderboardStore.shared.allEntries())
        lock.lock()
        cachedTeams = seeded
        cachedSource = seeded.isEmpty ? .none : .local
        lock.unlock()
        publish()
    }

    struct Snapshot: Equatable {
        var teams: [LeaderboardTeam]
        var source: TeamSource
        var lastFetchAt: Date?
        var lastError: String?
        var stale: Bool {
            guard let lastFetchAt else { return true }
            return Date().timeIntervalSince(lastFetchAt) > TeamStore.staleAfter
        }
    }

    func snapshot() -> Snapshot {
        lock.lock()
        defer { lock.unlock() }
        return Snapshot(teams: cachedTeams, source: cachedSource, lastFetchAt: cachedAt, lastError: cachedError)
    }

    func isStale() -> Bool { snapshot().stale }

    /// `GET /teams` payload for the loopback server. Cloud `GET /api/teams`
    /// when reachable, otherwise the same grouping computed from the entries
    /// already published on this machine.
    func endpointPayload(force: Bool = false) -> [String: Any] {
        if force || isStale() { refresh(force: force) }
        let snap = snapshot()
        return [
            "ok": true,
            "source": snap.source.rawValue,
            "total": snap.teams.count,
            "updatedAt": snap.lastFetchAt.map { Int($0.timeIntervalSince1970) } ?? 0,
            "error": snap.lastError ?? "",
            "teams": snap.teams.map { $0.toDict() }
        ]
    }

    /// `GET {cloud}/api/teams` with an If-None-Match revalidation, falling
    /// back to the local grouping when the cloud is unreachable.
    @discardableResult
    func refresh(force: Bool = false, completion: ((Snapshot) -> Void)? = nil) -> Snapshot {
        lock.lock()
        let last = cachedAt
        let busy = inFlight
        let due = force || last == nil || Date().timeIntervalSince(last!) > Self.staleAfter
        if due && !busy { inFlight = true }
        let etag = self.etag
        lock.unlock()

        guard due, !busy else {
            let snap = snapshot()
            completion?(snap)
            return snap
        }

        guard let url = Self.teamsURL(baseURL: LeaderboardStore.shared.cloudBaseURL() ?? "") else {
            // No cloud configured: the local grouping is the whole truth.
            finish(with: localSnapshot(), completion: completion)
            return snapshot()
        }

        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = 8.0
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let etag, !force { req.setValue(etag, forHTTPHeaderField: "If-None-Match") }

        URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            guard let self else { return }
            if let err {
                self.finish(with: self.fallbackSnapshot(error: err.localizedDescription), completion: completion)
                return
            }
            guard let http = resp as? HTTPURLResponse else {
                self.finish(with: self.fallbackSnapshot(error: "No HTTP response from the teams endpoint."),
                            completion: completion)
                return
            }
            if http.statusCode == 304 {
                self.finish(with: self.revalidatedSnapshot(), completion: completion)
                return
            }
            guard (200..<300).contains(http.statusCode), let data, !data.isEmpty else {
                self.finish(with: self.fallbackSnapshot(error: "Teams endpoint returned HTTP \(http.statusCode)."),
                            completion: completion)
                return
            }
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                self.finish(with: self.fallbackSnapshot(error: "Teams endpoint returned an unreadable payload."),
                            completion: completion)
                return
            }
            let rows = (obj["teams"] as? [[String: Any]] ?? []).compactMap(LeaderboardTeam.init(dict:))
            self.finish(with: .init(teams: rows, source: .cloud, lastFetchAt: Date(),
                                    lastError: rows.isEmpty ? "No teams published yet." : nil),
                        etag: Self.headerValue(http, "etag"), completion: completion)
        }.resume()

        return snapshot()
    }

    /// Fold the local entries into the current rows without discarding a
    /// cloud payload we still trust (used when the cloud is unreachable).
    private func fallbackSnapshot(error: String) -> Snapshot {
        lock.lock()
        let rows = cachedTeams
        let currentSource = cachedSource
        let fetchedAt = cachedAt
        lock.unlock()
        if !rows.isEmpty, currentSource == .cloud, let fetchedAt, Date().timeIntervalSince(fetchedAt) < 3600 {
            return Snapshot(teams: rows, source: .cloud, lastFetchAt: fetchedAt, lastError: error)
        }
        return Snapshot(teams: Self.localTeams(from: LeaderboardStore.shared.allEntries()),
                        source: .local, lastFetchAt: Date(), lastError: error)
    }

    private func localSnapshot() -> Snapshot {
        Snapshot(teams: Self.localTeams(from: LeaderboardStore.shared.allEntries()),
                 source: .local, lastFetchAt: Date(), lastError: nil)
    }

    private func revalidatedSnapshot() -> Snapshot {
        lock.lock()
        let teams = cachedTeams
        lock.unlock()
        return Snapshot(teams: teams, source: .cloud, lastFetchAt: Date(), lastError: nil)
    }

    private func finish(with snap: Snapshot, etag: String? = nil, completion: ((Snapshot) -> Void)?) {
        lock.lock()
        cachedTeams = snap.teams
        cachedSource = snap.source
        cachedAt = snap.lastFetchAt
        cachedError = snap.lastError
        if let etag { self.etag = etag }
        inFlight = false
        lock.unlock()
        DispatchQueue.main.async { [weak self] in
            self?.publish()
            completion?(snap)
        }
    }

    private func publish() {
        let snap = snapshot()
        teams = snap.teams
        source = snap.source
        lastFetchAt = snap.lastFetchAt
        lastError = snap.lastError
    }

    private static func headerValue(_ http: HTTPURLResponse, _ name: String) -> String? {
        for (key, value) in http.allHeaderFields {
            if let k = key as? String, k.lowercased() == name { return value as? String }
        }
        return nil
    }

    /// `{cloudBase}/api/teams`, derived from the same base normalization the
    /// leaderboard publish path uses, so a custom endpoint prefix survives.
    /// The worker's bare `/teams` is a team *profile* page — the JSON API is
    /// always `/api/teams`.
    static func teamsURL(baseURL: String) -> URL? {
        let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let url = CloudPublishCredentials.endpointURL(baseURL: trimmed),
              var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        var path = comps.percentEncodedPath
        if path.hasSuffix("/api/leaderboard") {
            path.removeLast("leaderboard".count)
            path += "teams"
        } else if path.hasSuffix("/leaderboard") {
            path.removeLast("leaderboard".count)
            path += "api/teams"
        } else {
            path += path.hasSuffix("/api") ? "/teams" : "/api/teams"
        }
        comps.percentEncodedPath = path
        return comps.url
    }

    /// Group leaderboard entries into team rows using the same key rule as
    /// `aggregateTeams`: a known `teamId` when present, otherwise the team
    /// label. Entries carrying a label that resolves to a known id join that
    /// id's row instead of splitting the team in two.
    static func localTeams(from entries: [LeaderboardEntry]) -> [LeaderboardTeam] {
        var idByLabel: [String: String] = [:]
        for entry in entries where !entry.teamId.isEmpty && !entry.team.isEmpty {
            idByLabel[entry.team.lowercased()] = entry.teamId
        }

        var rows: [String: LeaderboardTeam] = [:]
        // Keys whose display name came from a row the worker resolved from
        // membership (a non-local entry carrying the id). First one wins, so
        // the original first-seen naming is unchanged for an all-cloud group.
        var canonicalNames = Set<String>()
        for entry in entries {
            let label = entry.team.trimmingCharacters(in: .whitespacesAndNewlines)
            let resolvedId = entry.teamId.isEmpty ? idByLabel[label.lowercased()] ?? "" : entry.teamId
            let key = resolvedId.isEmpty ? "legacy:\(label.isEmpty ? "Unassigned" : label)" : "id:\(resolvedId)"
            var row = rows[key] ?? LeaderboardTeam(team: label.isEmpty ? "Unassigned" : label)
            if row.teamId.isEmpty && !resolvedId.isEmpty { row.teamId = resolvedId }
            // A membership name beats the free-text publish label, so a row
            // keyed by id never displays a label pointing at another team.
            if !entry.isLocal, !entry.teamId.isEmpty, entry.teamId == resolvedId, !entry.team.isEmpty,
               canonicalNames.insert(key).inserted {
                row.team = entry.team
            }
            row.tokens += entry.tokensAll
            row.tokensToday += entry.tokensToday
            row.tokens7d += entry.tokens7d
            row.cost += entry.costAll
            row.members += 1
            row.publishedToday += entry.tokensToday > 0 ? 1 : 0
            row.publishedWeek += entry.tokens7d > 0 ? 1 : 0
            row.users.append(LeaderboardTeamMember(handle: entry.handle, tokensAll: entry.tokensAll))
            if let breakdown = entry.breakdown {
                for model in breakdown.models {
                    let provider = model.provider.isEmpty ? "other" : model.provider
                    row.providers[provider, default: 0] += Double(model.tokensAll)
                }
                for point in breakdown.daily where point.tokens > 0 {
                    if let idx = row.daily.firstIndex(where: { $0.day == point.day }) {
                        row.daily[idx].tokens += point.tokens
                    } else {
                        row.daily.append(LeaderboardTeamDay(day: point.day, tokens: point.tokens))
                    }
                }
            }
            rows[key] = row
        }

        return rows.values
            .map { row -> LeaderboardTeam in
                var out = row
                out.users.sort { $0.tokensAll > $1.tokensAll }
                if out.users.count > 6 { out.users = Array(out.users.prefix(6)) }
                out.daily.sort { $0.day < $1.day }
                return out
            }
            .sorted { $0.tokens > $1.tokens }
    }
}
