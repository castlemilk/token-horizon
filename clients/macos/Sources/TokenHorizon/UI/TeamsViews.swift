import SwiftUI

/// TEAMS tab: aggregated team usage, refreshed from the cloud's
/// `GET /api/teams` with an on-device grouping of published entries as the
/// fallback (see `TeamStore`). Membership, invitations and logos stay on the
/// web — this surface only reports.
struct TeamsTabView: View {
    @ObservedObject private var store = TeamStore.shared

    @State private var period: LeaderboardPeriod = .week
    @State private var selectedTeamID: String?

    private static let periods: [LeaderboardPeriod] = [.today, .week, .all]

    private var localHandle: String {
        let handle = SettingsStore.shared.leaderboardHandle
        return handle.isEmpty ? NSUserName() : handle
    }

    private var sortedTeams: [LeaderboardTeam] {
        store.teams.sorted { $0.score(for: period) > $1.score(for: period) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            controls
            if let error = store.lastError, !store.teams.isEmpty { errorBanner(error) }
            if store.teams.isEmpty {
                emptyState
            } else {
                kpiStrip
                teamList
                if let selected = store.teams.first(where: { $0.id == selectedTeamID }) {
                    memberTable(for: selected)
                }
            }
        }
        .onAppear { store.refresh() }
        .task {
            while !Task.isCancelled {
                store.refresh()
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }

    // MARK: - Controls

    private var controls: some View {
        HStack(spacing: 6) {
            ForEach(Self.periods) { p in
                Button {
                    withAnimation(.easeOut(duration: 0.15)) { period = p }
                } label: {
                    Text(p.title.uppercased())
                        .font(.system(size: 8.5, weight: .heavy, design: .monospaced))
                        .foregroundStyle(period == p ? Color.black : Color.white.opacity(0.55))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Capsule().fill(period == p ? Color.white : Color.white.opacity(0.1)))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }

            Spacer()

            sourceBadge

            Button {
                store.refresh(force: true)
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(Color.cyan)
                    .padding(.horizontal, 7).padding(.vertical, 3.5)
                    .background(RoundedRectangle(cornerRadius: 4).fill(Color.cyan.opacity(0.14)))
                    .contentShape(RoundedRectangle(cornerRadius: 4))
            }
            .buttonStyle(.plain)
            .help("Refresh team aggregates")
            .accessibilityLabel("Refresh team aggregates")

            Button { openWeb(.teams) } label: {
                HStack(spacing: 3) {
                    Image(systemName: "person.badge.key").font(.system(size: 8.5))
                    Text("Manage teams").font(.system(size: 8.5, weight: .heavy, design: .monospaced))
                }
                .foregroundStyle(Color.white.opacity(0.9))
                .padding(.horizontal, 7).padding(.vertical, 3.5)
                .background(RoundedRectangle(cornerRadius: 4).fill(Color.white.opacity(0.12)))
                .contentShape(RoundedRectangle(cornerRadius: 4))
            }
            .buttonStyle(.plain)
            .help("Team membership and invitations are managed on the web")
            .accessibilityLabel("Manage teams on the web")
        }
    }

    private var sourceBadge: some View {
        let (label, color): (String, Color) = {
            switch store.source {
            case .cloud: return ("CLOUD", .cyan)
            case .local: return ("LOCAL", .orange)
            case .none: return ("—", .gray)
            }
        }()
        let stamp = store.lastFetchAt.map(Self.relative) ?? "never"
        return HStack(spacing: 4) {
            Text(label)
                .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                .foregroundStyle(color)
            Text(stamp)
                .font(.system(size: 7.5, design: .monospaced))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 6).padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: 4).fill(Color.white.opacity(0.06)))
        .help(store.source == .local
              ? "Cloud unreachable — grouped from the entries published on this Mac."
              : "Aggregates come from the Token Horizon cloud.")
    }

    private func errorBanner(_ error: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 9)).foregroundStyle(.orange)
            Text(error)
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(.orange)
                .lineLimit(2)
            Spacer()
            if let stamp = store.lastFetchAt {
                Text("cached \(Self.relative(stamp))")
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.orange.opacity(0.1)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.orange.opacity(0.3)))
    }

    // MARK: - KPIs

    private var kpiStrip: some View {
        let members = store.teams.reduce(0) { $0 + $1.members }
        let totalTokens = store.teams.reduce(0) { $0 + $1.score(for: period) }
        let mine = store.teams.first { team in
            team.users.contains { $0.handle.lowercased() == localHandle.lowercased() }
        }

        return HStack(spacing: 8) {
            kpi("TEAMS", String(store.teams.count), .cyan,
                mine.map { "your team: \($0.team)" } ?? "no team joined")
            kpi("PUBLISHED PROFILES", String(members), .green,
                "members reporting usage")
            kpi(period.title.uppercased() + " TOKENS", UsageSnapshot.tokens(totalTokens), .yellow,
                store.teams.first.map { "\($0.scoreFormatted(for: period)) leads" } ?? "")
            kpi("YOUR TEAM", mine?.team ?? "—", .orange,
                mine.map { "\($0.members) published · \($0.costFormatted)" } ?? "join or publish a team")
        }
    }

    private func kpi(_ label: String, _ value: String, _ color: Color, _ sub: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            teamsLabel(label)
            Text(value)
                .font(.system(size: 13, weight: .heavy, design: .monospaced))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(sub)
                .font(.system(size: 7.5, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(color.opacity(0.25)))
    }

    // MARK: - Team list

    private var teamList: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                teamsLabel("TEAM RANKINGS · \(period.title.uppercased())")
                Spacer()
                if !store.teams.isEmpty {
                    teamsLabel("\(store.teams.count) TEAM\(store.teams.count == 1 ? "" : "S")")
                }
            }
            VStack(spacing: 4) {
                ForEach(Array(sortedTeams.enumerated()), id: \.element.id) { index, team in
                    teamRow(rank: index + 1, team: team)
                }
            }
        }
    }

    private func teamRow(rank: Int, team: LeaderboardTeam) -> some View {
        let selected = selectedTeamID == team.id
        let isMine = team.users.contains { $0.handle.lowercased() == localHandle.lowercased() }

        return VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Text("#\(rank)")
                    .font(.system(size: 9, weight: .heavy, design: .monospaced))
                    .foregroundStyle(rank <= 3 ? Color.yellow : Color.secondary)
                    .frame(width: 28, alignment: .leading)

                monogram(for: team)

                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        Text(team.team)
                            .font(.system(size: 11, weight: .heavy, design: .monospaced))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                        if isMine {
                            Text("YOU")
                                .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                                .foregroundStyle(Color.black)
                                .padding(.horizontal, 4).padding(.vertical, 1)
                                .background(Capsule().fill(Color.yellow))
                        }
                        if let count = team.memberCount {
                            Text("ROSTER \(count)")
                                .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }
                    }
                    Text("\(team.members) published\(team.publishedWeek > 0 ? " · \(team.publishedWeek) reporting this week" : "")")
                        .font(.system(size: 7.5, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }

                Spacer(minLength: 4)

                VStack(alignment: .trailing, spacing: 1) {
                    Text(team.scoreFormatted(for: period))
                        .font(.system(size: 11, weight: .heavy, design: .monospaced))
                        .foregroundStyle(Color.cyan)
                    Text(team.costFormatted)
                        .font(.system(size: 7.5, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                .frame(width: 74, alignment: .trailing)

                Sparkline(values: sparkValues(team), color: .green)
                    .frame(width: 64, height: 18)

                Image(systemName: selected ? "chevron.up" : "chevron.down")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(.tertiary)
            }
            providerMix(team)
            if !team.users.isEmpty {
                HStack(spacing: 6) {
                    ForEach(team.users.prefix(3), id: \.handle) { user in
                        HStack(spacing: 3) {
                            Text("@\(user.handle)")
                                .font(.system(size: 7.5, design: .monospaced))
                                .foregroundStyle(user.handle.lowercased() == localHandle.lowercased()
                                                 ? Color.yellow : Color.white.opacity(0.75))
                            Text(UsageSnapshot.tokens(user.tokensAll))
                                .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, 5).padding(.vertical, 1.5)
                        .background(Capsule().fill(Color.white.opacity(0.06)))
                    }
                    Spacer()
                }
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Color.cyan.opacity(0.08) : Color.white.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 6)
            .strokeBorder(selected ? Color.cyan.opacity(0.4)
                          : (isMine ? Color.yellow.opacity(0.3) : Color.white.opacity(0.1))))
        .contentShape(Rectangle())
        .onTapGesture {
            withAnimation(.easeInOut(duration: 0.18)) {
                selectedTeamID = selected ? nil : team.id
            }
        }
        .accessibilityLabel("\(team.team), rank \(rank), \(team.scoreFormatted(for: period)) tokens")
    }

    private func monogram(for team: LeaderboardTeam) -> some View {
        let initials = String(team.team.prefix(2)).uppercased()
        return Text(initials)
            .font(.system(size: 9, weight: .heavy, design: .monospaced))
            .foregroundStyle(Color.black)
            .frame(width: 22, height: 22)
            .background(Circle().fill(color(for: team.team)))
    }

    private func providerMix(_ team: LeaderboardTeam) -> some View {
        let mix = team.providerMix
        let total = mix.reduce(0.0) { $0 + $1.tokens }
        return HStack(spacing: 6) {
            GeometryReader { geo in
                HStack(spacing: 1.5) {
                    ForEach(Array(mix.prefix(5).enumerated()), id: \.offset) { idx, item in
                        RoundedRectangle(cornerRadius: 2)
                            .fill(color(for: item.provider))
                            .frame(width: max(3, geo.size.width * CGFloat(item.tokens / Swift.max(total, 1))))
                            .opacity(idx == 0 ? 1 : 0.75)
                    }
                    Spacer(minLength: 0)
                }
            }
            .frame(height: 5)
            if let top = mix.first {
                Text("\(DashboardTabs.providerNameDisplay(top.provider)) \(Int((top.tokens / Swift.max(total, 1)) * 100))%")
                    .font(.system(size: 7, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    // MARK: - Members

    private func memberTable(for team: LeaderboardTeam) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                teamsLabel("MEMBERS · \(team.team.uppercased())")
                Spacer()
                Button("Open team page ↗") { openWeb(.teams) }
                    .buttonStyle(.plain)
                    .font(.system(size: 8, weight: .heavy, design: .monospaced))
                    .foregroundStyle(Color.cyan)
            }
            HStack(spacing: 6) {
                Text("#").frame(width: 24, alignment: .leading)
                Text("MEMBER").frame(minWidth: 100, alignment: .leading)
                Spacer()
                Text("ALL-TIME").frame(width: 74, alignment: .trailing)
                Text("SHARE").frame(width: 74, alignment: .trailing)
            }
            .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
            .foregroundStyle(.tertiary)
            .padding(.horizontal, 6)

            Divider().overlay(Color.white.opacity(0.1))

            let total = Swift.max(team.tokens, 1)
            ForEach(Array(team.users.enumerated()), id: \.element.handle) { index, user in
                let isMine = user.handle.lowercased() == localHandle.lowercased()
                HStack(spacing: 6) {
                    Text("\(index + 1)")
                        .font(.system(size: 8.5, weight: .heavy, design: .monospaced))
                        .foregroundStyle(isMine ? Color.yellow : .secondary)
                        .frame(width: 24, alignment: .leading)
                    Text("@\(user.handle)")
                        .font(.system(size: 9.5, design: .monospaced))
                        .foregroundStyle(isMine ? Color.yellow : Color.white.opacity(0.9))
                        .lineLimit(1)
                    Spacer()
                    Text(UsageSnapshot.tokens(user.tokensAll))
                        .font(.system(size: 9, weight: .heavy, design: .monospaced))
                        .foregroundStyle(Color.cyan)
                        .frame(width: 74, alignment: .trailing)
                    Text(String(format: "%.1f%%", (Double(user.tokensAll) / Double(total)) * 100))
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .frame(width: 74, alignment: .trailing)
                }
                .padding(.horizontal, 6).padding(.vertical, 3)
                .background(RoundedRectangle(cornerRadius: 4)
                    .fill(isMine ? Color.yellow.opacity(0.08) : Color.clear))
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.03)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.1)))
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: "person.3.sequence")
                .font(.system(size: 22, weight: .light))
                .foregroundStyle(.tertiary)
            teamsLabel("NO TEAMS YET")
            Text(store.source == .cloud
                 ? "Nobody has published team usage yet. Set a published team label in Settings → Sharing & teams, then refresh."
                 : store.lastError != nil
                   ? "Could not reach the team service, and there is no local team usage to fall back to."
                   : "Teams are aggregated from published usage. Publish with a team label, or join a team on the web.")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button("Sharing settings…") {
                    NotificationCenter.default.post(name: .selectDashboardTab, object: DashboardTab.settings,
                                                    userInfo: ["settingsSection": AppSettingsSection.sharing])
                }
                .buttonStyle(.plain)
                .font(.system(size: 9, weight: .heavy, design: .monospaced))
                .foregroundStyle(Color.cyan)

                Button("Manage teams ↗") { openWeb(.teams) }
                    .buttonStyle(.plain)
                    .font(.system(size: 9, weight: .heavy, design: .monospaced))
                    .foregroundStyle(Color.cyan)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.03)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.white.opacity(0.1)))
    }

    // MARK: - Helpers

    private func sparkValues(_ team: LeaderboardTeam) -> [Double] {
        let values = team.daily.suffix(30).map { Double($0.tokens) }
        if values.isEmpty { return [] }
        return values
    }

    private func teamsLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 8, weight: .heavy, design: .monospaced))
            .foregroundStyle(.tertiary)
            .kerning(1)
    }

    private func openWeb(_ destination: WebDestination) {
        NotificationCenter.default.post(name: .openWebDestination, object: destination)
    }

    /// Stable color per name so provider segments and monograms never reshuffle
    /// between renders.
    private func color(for name: String) -> Color {
        let palette: [Color] = [.cyan, .green, .yellow, .orange, .pink, .purple, .blue, .mint]
        var hash: UInt64 = 5381
        for byte in name.utf8 { hash = (hash &* 33) &+ UInt64(byte) }
        return palette[Int(hash % UInt64(palette.count))]
    }

    private static func relative(_ date: Date) -> String {
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(seconds / 60)m ago" }
        if seconds < 86_400 { return "\(seconds / 3600)h ago" }
        return "\(seconds / 86_400)d ago"
    }
}
