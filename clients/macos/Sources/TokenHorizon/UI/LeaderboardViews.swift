import SwiftUI

/// LEADERBOARD tab: period rankings with league/MMR standings, 7-day rank
/// deltas, per-entry token trends and share cards. Extracted from
/// DashboardTabs and self-contained like `TeamsTabView` — presentation state
/// (period, team filter, row density, selection) lives here. All analytics
/// (league, MMR, Δ7d, trend) are computed by `LeaderboardStore.rankings` /
/// `LeaderboardAnalytics`; this view only renders.
struct LeaderboardTabView: View {
    /// Compact rows are single-line; cozy rows add a usage sub-line.
    enum RowDensity: String, CaseIterable, Identifiable {
        case compact, cozy
        var id: String { rawValue }
    }

    @ObservedObject var model: UIModel
    var onOpenSettings: () -> Void = {}

    @State private var period: LeaderboardPeriod = .today
    @State private var teamFilter = ""
    @State private var shareFormat: ShareCardFormat = .markdown
    @State private var copiedNotice = false
    @State private var selected: LeaderboardRankedEntry?
    @State private var density: RowDensity = .compact

    var body: some View {
        let rankings = LeaderboardStore.shared.rankings(for: period, teamFilter: teamFilter)
        let localRanked = rankings.first(where: { $0.entry.isLocal })

        return VStack(alignment: .leading, spacing: 10) {
            headerBar
            filterRow
            kpiCards(localRanked: localRanked, totalParticipants: rankings.count)
            chartsRow(rankings: rankings, localRanked: localRanked)
            HStack(spacing: 8) {
                sectionLabel("PARTICIPANT RANKINGS · \(period.title.uppercased())")
                Spacer()
                densityPicker
            }
            rankingsTable(rankings)
            shareCardPreview
        }
    }

    // MARK: - Header

    private var headerBar: some View {
        HStack(spacing: 6) {
            ForEach(LeaderboardPeriod.allCases) { p in
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

            HStack(spacing: 2) {
                ForEach(ShareCardFormat.allCases) { fmt in
                    Button {
                        shareFormat = fmt
                    } label: {
                        Text(fmt.rawValue.uppercased())
                            .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                            .foregroundStyle(shareFormat == fmt ? Color.cyan : Color.white.opacity(0.4))
                            .padding(.horizontal, 4).padding(.vertical, 2)
                            .background(RoundedRectangle(cornerRadius: 3).fill(shareFormat == fmt ? Color.cyan.opacity(0.15) : Color.clear))
                            .contentShape(RoundedRectangle(cornerRadius: 3))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(2)
            .background(RoundedRectangle(cornerRadius: 4).fill(Color.white.opacity(0.06)))

            Button {
                let ok = LeaderboardStore.shared.copyShareCard(for: period, format: shareFormat)
                if ok {
                    copiedNotice = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                        copiedNotice = false
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: copiedNotice ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 8.5))
                    Text(copiedNotice ? "Copied!" : "Share Card")
                        .font(.system(size: 8.5, weight: .heavy, design: .monospaced))
                }
                .foregroundStyle(copiedNotice ? Color.green : Color.white.opacity(0.9))
                .padding(.horizontal, 7).padding(.vertical, 3.5)
                .background(RoundedRectangle(cornerRadius: 4).fill(Color.white.opacity(0.12)))
                .contentShape(RoundedRectangle(cornerRadius: 4))
            }
            .buttonStyle(.plain)
        }
    }

    private var filterRow: some View {
        HStack(spacing: 10) {
            TextField("Filter by team", text: $teamFilter)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 220)
            densityPicker
            Spacer()
            Button("Sharing settings…") { onOpenSettings() }
                .buttonStyle(.plain).foregroundStyle(.cyan)
            Button("Open web leaderboard ↗") {
                NotificationCenter.default.post(name: .openWebDestination, object: WebDestination.leaderboard)
            }
            .buttonStyle(.plain).foregroundStyle(.cyan)
        }
        .font(.system(size: 11))
    }

    private var densityPicker: some View {
        HStack(spacing: 2) {
            ForEach(RowDensity.allCases) { d in
                Button {
                    withAnimation(.easeOut(duration: 0.12)) { density = d }
                } label: {
                    Text(d.rawValue.uppercased())
                        .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                        .foregroundStyle(density == d ? Color.black : Color.white.opacity(0.5))
                        .padding(.horizontal, 6).padding(.vertical, 2.5)
                        .background(Capsule().fill(density == d ? Color.white : Color.white.opacity(0.08)))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - KPI cards

    private func kpiCards(localRanked: LeaderboardRankedEntry?, totalParticipants: Int) -> some View {
        HStack(spacing: 8) {
            rankCard(localRanked: localRanked, totalParticipants: totalParticipants)
            volumeCard(localRanked: localRanked)
            streakCard
            hardwareCard(localRanked: localRanked)
        }
    }

    private func rankCard(localRanked: LeaderboardRankedEntry?, totalParticipants: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                sectionLabel("YOUR RANK")
                Spacer()
                if localRanked != nil {
                    Text("Details ↗")
                        .font(.system(size: 7, weight: .bold, design: .monospaced))
                        .foregroundStyle(Color.yellow.opacity(0.8))
                }
            }
            Text(localRanked?.badge ?? "#1 🥇")
                .font(.system(size: 13, weight: .heavy, design: .monospaced))
                .foregroundStyle(Color.yellow)
            Text("Top \(String(format: "%.0f%%", localRanked?.percentile ?? 100)) of \(totalParticipants)")
                .font(.system(size: 7.5, design: .monospaced))
                .foregroundStyle(.secondary)
            let rankTrend = rankTrendValues(localRanked?.entry)
            if !rankTrend.isEmpty {
                Sparkline(values: rankTrend, color: .yellow)
                    .frame(height: 15)
                    .padding(.top, 2)
            }
        }
        .padding(6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(selected?.id == localRanked?.id ? Color.yellow.opacity(0.12) : Color.white.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.yellow.opacity(0.25)))
        .contentShape(Rectangle())
        .onTapGesture {
            if let local = localRanked {
                withAnimation(.easeInOut(duration: 0.18)) {
                    selected = selected?.id == local.id ? nil : local
                }
            }
        }
    }

    private func volumeCard(localRanked: LeaderboardRankedEntry?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            sectionLabel(period.title.uppercased())
            Text(localRanked?.scoreFormatted ?? UsageSnapshot.tokens(model.usage.tokensToday))
                .font(.system(size: 13, weight: .heavy, design: .monospaced))
                .foregroundStyle(Color.cyan)
            Text(localRanked?.costFormatted ?? "$0.00")
                .font(.system(size: 7.5, design: .monospaced))
                .foregroundStyle(.secondary)
        }
        .padding(6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.cyan.opacity(0.25)))
    }

    private var streakCard: some View {
        VStack(alignment: .leading, spacing: 2) {
            sectionLabel("ACTIVE STREAK")
            Text("🔥 \(model.historyStreak) Days")
                .font(.system(size: 13, weight: .heavy, design: .monospaced))
                .foregroundStyle(Color.orange)
            Text("Consecutive days")
                .font(.system(size: 7.5, design: .monospaced))
                .foregroundStyle(.secondary)
        }
        .padding(6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.orange.opacity(0.25)))
    }

    private func hardwareCard(localRanked: LeaderboardRankedEntry?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            sectionLabel("HARDWARE")
            Text(localRanked?.entry.hardware ?? SystemStats.cpuBrandString())
                .font(.system(size: 11, weight: .heavy, design: .monospaced))
                .foregroundStyle(Color.white.opacity(0.95))
                .lineLimit(1)
            Text(localRanked?.entry.topModel ?? "claude-3-7-sonnet")
                .font(.system(size: 7.5, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.12)))
    }

    // MARK: - Charts

    private func chartsRow(rankings: [LeaderboardRankedEntry], localRanked: LeaderboardRankedEntry?) -> some View {
        HStack(alignment: .top, spacing: 8) {
            leagueDistributionCard(rankings: rankings)
            standingCard(localRanked: localRanked)
        }
    }

    private func leagueDistributionCard(rankings: [LeaderboardRankedEntry]) -> some View {
        let tiers: [(tier: LeagueTier, count: Int)] = LeagueTier.allCases.compactMap { tier in
            let count = rankings.filter { LeagueTier.from($0.entry.league) == tier }.count
            return count > 0 ? (tier, count) : nil
        }
        let maxCount = tiers.map { $0.count }.max() ?? 1

        return VStack(alignment: .leading, spacing: 4) {
            sectionLabel("LEAGUE DISTRIBUTION")
            if tiers.isEmpty {
                Text("No league data yet.")
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(.tertiary)
            } else {
                ForEach(tiers, id: \.tier) { item in
                    HStack(spacing: 5) {
                        Circle().fill(tierColor(item.tier)).frame(width: 5, height: 5)
                        Text(item.tier.title)
                            .font(.system(size: 8, design: .monospaced))
                            .foregroundStyle(Color.white.opacity(0.8))
                            .frame(width: 74, alignment: .leading)
                        GeometryReader { geo in
                            Capsule()
                                .fill(tierColor(item.tier).opacity(0.75))
                                .frame(width: max(3, geo.size.width * CGFloat(item.count) / CGFloat(maxCount)), height: 5)
                                .frame(maxHeight: .infinity, alignment: .center)
                        }
                        Text("\(item.count)")
                            .font(.system(size: 8, weight: .bold, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .frame(width: 18, alignment: .trailing)
                    }
                }
            }
        }
        .padding(6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.03)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.08)))
    }

    private func standingCard(localRanked: LeaderboardRankedEntry?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            sectionLabel("YOUR STANDING")
            if let local = localRanked {
                let standing = local.entry.standing
                HStack(spacing: 5) {
                    Circle().fill(tierColor(standing.league)).frame(width: 7, height: 7)
                    Text(standing.title)
                        .font(.system(size: 11, weight: .heavy, design: .monospaced))
                        .foregroundStyle(Color.white)
                    Spacer()
                    Text("\(standing.mmr) MMR")
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundStyle(Color.cyan)
                }
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.white.opacity(0.08))
                        Capsule().fill(tierColor(standing.league))
                            .frame(width: max(4, geo.size.width * CGFloat(standing.progressWithinLeague)))
                    }
                }
                .frame(height: 4)
                if let next = standing.league.next, let toNext = standing.mmrToNext {
                    Text("\(toNext) MMR to \(next.title)")
                        .font(.system(size: 7.5, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("Publish a snapshot to join the league.")
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.03)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.08)))
    }

    // MARK: - Rankings table

    private func rankingsTable(_ rankings: [LeaderboardRankedEntry]) -> some View {
        VStack(spacing: 1) {
            HStack(spacing: 6) {
                Text("RANK").frame(width: 40, alignment: .leading)
                Text("Δ7D").frame(width: 30, alignment: .trailing)
                Text("PARTICIPANT").frame(minWidth: 96, alignment: .leading)
                Text("TEAM").frame(width: 56, alignment: .leading)
                Text("VOLUME").frame(width: 62, alignment: .trailing)
                Text("SHARE").frame(width: 64, alignment: .leading)
                Text("TREND").frame(width: 48, alignment: .center)
                Text("STREAK").frame(width: 40, alignment: .trailing)
                Spacer().frame(width: 12)
            }
            .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
            .foregroundStyle(.tertiary)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)

            Divider().overlay(Color.white.opacity(0.1))

            ForEach(rankings) { item in
                rankingRow(item)
            }
        }
        .padding(6)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.03)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.08)))
    }

    private func rankingRow(_ item: LeaderboardRankedEntry) -> some View {
        let isUser = item.entry.isLocal
        let isSelected = selected?.id == item.id

        return VStack(spacing: 0) {
            HStack(spacing: 6) {
                Text(item.badge)
                    .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                    .foregroundStyle(item.rank == 1 ? Color.yellow : item.rank == 2 ? Color.white : item.rank == 3 ? Color.orange : Color.secondary)
                    .frame(width: 40, alignment: .leading)

                rankDeltaView(item.rankDelta7d)
                    .frame(width: 30, alignment: .trailing)

                participantColumn(item, isUser: isUser)
                    .frame(minWidth: 96, alignment: .leading)

                Text(item.entry.team.isEmpty ? "—" : item.entry.team)
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .frame(width: 56, alignment: .leading)
                    .lineLimit(1)

                VStack(alignment: .trailing, spacing: 0) {
                    Text(item.scoreFormatted)
                        .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                        .foregroundStyle(Color.cyan)
                    if item.costFormatted != "$0.00" {
                        Text(item.costFormatted)
                            .font(.system(size: 7, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(width: 62, alignment: .trailing)

                GeometryReader { barGeo in
                    ZStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(Color.white.opacity(0.08))
                            .frame(height: 5)
                        RoundedRectangle(cornerRadius: 2)
                            .fill(isUser ? Color.green : Color.cyan.opacity(0.7))
                            .frame(width: max(2, barGeo.size.width * CGFloat(item.relativePercent / 100.0)), height: 5)
                    }
                    .frame(maxHeight: .infinity, alignment: .center)
                }
                .frame(width: 64, height: 16)

                Group {
                    if item.trend.count >= 2 {
                        Sparkline(values: item.trend.map(Double.init), color: isUser ? .green : .cyan)
                    } else {
                        Text("—")
                            .font(.system(size: 8, design: .monospaced))
                            .foregroundStyle(.tertiary)
                    }
                }
                .frame(width: 48, height: 16)

                Text("🔥\(item.entry.streakDays)d")
                    .font(.system(size: 8, weight: .semibold, design: .monospaced))
                    .foregroundStyle(item.entry.streakDays >= 7 ? Color.orange : Color.secondary)
                    .frame(width: 40, alignment: .trailing)

                Image(systemName: isSelected ? "chevron.up.circle.fill" : "chevron.right")
                    .font(.system(size: 8.5, weight: .bold))
                    .foregroundStyle(isSelected ? Color.cyan : Color.white.opacity(0.35))
                    .frame(width: 12, alignment: .center)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, density == .cozy ? 6 : 4)
            .background(RoundedRectangle(cornerRadius: 4).fill(isSelected ? Color.cyan.opacity(0.16) : (isUser ? Color.white.opacity(0.06) : Color.clear)))
            .contentShape(Rectangle())
            .onTapGesture {
                withAnimation(.easeInOut(duration: 0.18)) {
                    selected = selected?.id == item.id ? nil : item
                }
            }

            if isSelected {
                leaderboardUserDetailView(item: item)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 6)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private func participantColumn(_ item: LeaderboardRankedEntry, isUser: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                if let tier = LeagueTier.from(item.entry.league) {
                    Circle().fill(tierColor(tier)).frame(width: 5, height: 5)
                }
                if isUser {
                    Circle().fill(Color.green).frame(width: 5, height: 5)
                }
                Text(item.entry.displayHandle)
                    .font(.system(size: 9, weight: isUser ? .heavy : .medium, design: .monospaced))
                    .foregroundStyle(isUser ? Color.white : Color.white.opacity(0.85))
                    .lineLimit(1)
                if isUser {
                    Text("YOU")
                        .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                        .foregroundStyle(Color.black)
                        .padding(.horizontal, 3).padding(.vertical, 1)
                        .background(Capsule().fill(Color.green))
                }
            }
            if density == .cozy {
                HStack(spacing: 5) {
                    Text(item.entry.topModel)
                        .font(.system(size: 7, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if let tier = LeagueTier.from(item.entry.league) {
                        Text("\(tier.title) \(romanDivision(item.division)) · \(item.mmr) MMR")
                            .font(.system(size: 7, design: .monospaced))
                            .foregroundStyle(tierColor(tier).opacity(0.9))
                            .lineLimit(1)
                    }
                    Text("↧\(item.inputFormatted) ↥\(item.outputFormatted) · \(item.requestsFormatted) req")
                        .font(.system(size: 7, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
        }
    }

    private func rankDeltaView(_ delta: Int?) -> some View {
        Group {
            if let delta, delta != 0 {
                HStack(spacing: 1) {
                    Image(systemName: delta > 0 ? "arrow.up" : "arrow.down")
                        .font(.system(size: 6.5, weight: .heavy))
                    Text("\(abs(delta))")
                        .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                }
                .foregroundStyle(delta > 0 ? Color.green : Color.red)
            } else {
                Text("—")
                    .font(.system(size: 7.5, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    // MARK: - Expanded drawer

    private func leaderboardUserDetailView(item: LeaderboardRankedEntry) -> some View {
        let entry = item.entry
        let bd = entry.resolvedBreakdown()
        let isUser = entry.isLocal

        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ZStack {
                    Circle()
                        .fill(item.rank == 1 ? Color.yellow.opacity(0.2) : (item.rank == 2 ? Color.white.opacity(0.15) : (item.rank == 3 ? Color.orange.opacity(0.2) : Color.cyan.opacity(0.15))))
                        .frame(width: 28, height: 28)
                    Text(item.badge.components(separatedBy: " ").last ?? "👤")
                        .font(.system(size: 13))
                }

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 5) {
                        Text(entry.displayHandle)
                            .font(.system(size: 11, weight: .heavy, design: .monospaced))
                            .foregroundStyle(.white)

                        if isUser {
                            Text("YOU")
                                .font(.system(size: 7, weight: .heavy, design: .monospaced))
                                .foregroundStyle(Color.black)
                                .padding(.horizontal, 4).padding(.vertical, 1)
                                .background(Capsule().fill(Color.green))
                        }

                        Text("Rank #\(item.rank)")
                            .font(.system(size: 8, weight: .bold, design: .monospaced))
                            .foregroundStyle(Color.yellow)
                            .padding(.horizontal, 4).padding(.vertical, 1)
                            .background(RoundedRectangle(cornerRadius: 3).fill(Color.yellow.opacity(0.12)))

                        if let tier = LeagueTier.from(entry.league) {
                            Text("\(tier.title) \(romanDivision(item.division)) · \(item.mmr) MMR")
                                .font(.system(size: 8, weight: .bold, design: .monospaced))
                                .foregroundStyle(Color.white)
                                .padding(.horizontal, 4).padding(.vertical, 1)
                                .background(RoundedRectangle(cornerRadius: 3).fill(tierColor(tier).opacity(0.4)))
                        }

                        if let delta = item.rankDelta7d, delta != 0 {
                            Text(delta > 0 ? "▲\(delta) 7d" : "▼\(abs(delta)) 7d")
                                .font(.system(size: 8, weight: .bold, design: .monospaced))
                                .foregroundStyle(delta > 0 ? Color.green : Color.red)
                                .padding(.horizontal, 4).padding(.vertical, 1)
                                .background(RoundedRectangle(cornerRadius: 3).fill((delta > 0 ? Color.green : Color.red).opacity(0.12)))
                        }

                        if !entry.team.isEmpty {
                            Text(entry.team)
                                .font(.system(size: 8, weight: .medium, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.7))
                                .padding(.horizontal, 4).padding(.vertical, 1)
                                .background(RoundedRectangle(cornerRadius: 3).fill(Color.white.opacity(0.08)))
                        }

                        if !entry.hardware.isEmpty {
                            Text(entry.hardware)
                                .font(.system(size: 7.5, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 4).padding(.vertical, 1)
                                .background(RoundedRectangle(cornerRadius: 3).fill(Color.white.opacity(0.05)))
                        }

                        Text("🔥 \(entry.streakDays)d streak")
                            .font(.system(size: 8, weight: .bold, design: .monospaced))
                            .foregroundStyle(Color.orange)
                            .padding(.horizontal, 4).padding(.vertical, 1)
                            .background(RoundedRectangle(cornerRadius: 3).fill(Color.orange.opacity(0.12)))
                    }

                    Text("Updated \(DateFormatter.localizedString(from: entry.updatedAt, dateStyle: .short, timeStyle: .short))")
                        .font(.system(size: 7.5, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.4))
                }

                Spacer()

                Button {
                    let card = LeaderboardStore.shared.generateShareCard(for: period, format: shareFormat, entryId: entry.id)
                    #if canImport(AppKit)
                    let pasteboard = NSPasteboard.general
                    pasteboard.clearContents()
                    pasteboard.setString(card, forType: .string)
                    #endif
                    copiedNotice = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                        copiedNotice = false
                    }
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "doc.on.doc")
                        Text("Share Card")
                    }
                    .font(.system(size: 8, weight: .bold, design: .monospaced))
                    .foregroundStyle(Color.cyan)
                    .padding(.horizontal, 6).padding(.vertical, 3)
                    .background(RoundedRectangle(cornerRadius: 4).fill(Color.cyan.opacity(0.12)))
                }
                .buttonStyle(.plain)

                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        selected = nil
                    }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(.white.opacity(0.5))
                }
                .buttonStyle(.plain)
            }

            HStack(spacing: 6) {
                userMetricBox(title: "TODAY", value: UsageSnapshot.tokens(entry.tokensToday), sub: entry.costToday > 0 ? UsageSnapshot.cost(entry.costToday) : "—", color: .cyan)
                userMetricBox(title: "7 DAYS", value: UsageSnapshot.tokens(entry.tokens7d), sub: entry.cost7d > 0 ? UsageSnapshot.cost(entry.cost7d) : "—", color: .blue)
                userMetricBox(title: "ALL-TIME", value: UsageSnapshot.tokens(entry.tokensAll), sub: entry.costAll > 0 ? UsageSnapshot.cost(entry.costAll) : "—", color: .purple)
                userMetricBox(title: "TOP MODEL", value: entry.topModel, sub: "Primary Driver", color: .green)
            }

            if !bd.history.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("7-DAY TOKEN ACTIVITY")
                        .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                        .foregroundStyle(.secondary)

                    let maxTok = Swift.max(bd.history.map { $0.tokens }.max() ?? 1, 1)
                    HStack(alignment: .bottom, spacing: 6) {
                        ForEach(bd.history) { pt in
                            VStack(spacing: 2) {
                                Text(UsageSnapshot.tokens(pt.tokens))
                                    .font(.system(size: 6.5, weight: .bold, design: .monospaced))
                                    .foregroundStyle(pt.tokens > 0 ? Color.cyan : Color.white.opacity(0.3))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.7)

                                ZStack(alignment: .bottom) {
                                    RoundedRectangle(cornerRadius: 2)
                                        .fill(Color.white.opacity(0.06))
                                        .frame(height: 32)

                                    let h = maxTok > 0 ? CGFloat(Double(pt.tokens) / Double(maxTok)) * 32.0 : 0
                                    RoundedRectangle(cornerRadius: 2)
                                        .fill(LinearGradient(
                                            gradient: Gradient(colors: [Color.cyan.opacity(0.9), Color.blue.opacity(0.7)]),
                                            startPoint: .top,
                                            endPoint: .bottom
                                        ))
                                        .frame(height: max(2, h))
                                }
                                .frame(maxWidth: .infinity)

                                Text(pt.dayLabel)
                                    .font(.system(size: 7, design: .monospaced))
                                    .foregroundStyle(.white.opacity(0.5))
                            }
                        }
                    }
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 4).fill(Color.black.opacity(0.3)))
                }
            }

            if !bd.models.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text("MODEL ALLOCATION (\(bd.models.count))")
                            .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text("TOKENS · COST · SHARE")
                            .font(.system(size: 7, design: .monospaced))
                            .foregroundStyle(.tertiary)
                    }

                    VStack(spacing: 2) {
                        ForEach(bd.models.sorted(by: { $0.tokensAll > $1.tokensAll })) { m in
                            HStack(spacing: 6) {
                                ProviderLogoView(provider: m.provider, model: m.model, size: 13)

                                Text(m.model)
                                    .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                                    .foregroundStyle(.white.opacity(0.9))
                                    .lineLimit(1)

                                Spacer()

                                VStack(alignment: .trailing, spacing: 0) {
                                    Text(UsageSnapshot.tokens(m.tokensToday > 0 ? m.tokensToday : m.tokensAll))
                                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                                        .foregroundStyle(Color.cyan)
                                    if m.costToday > 0 || m.costAll > 0 {
                                        Text(UsageSnapshot.cost(m.costToday > 0 ? m.costToday : m.costAll))
                                            .font(.system(size: 6.5, design: .monospaced))
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                .frame(width: 60, alignment: .trailing)

                                ZStack(alignment: .leading) {
                                    RoundedRectangle(cornerRadius: 1.5)
                                        .fill(Color.white.opacity(0.08))
                                        .frame(height: 4)
                                    RoundedRectangle(cornerRadius: 1.5)
                                        .fill(Color.cyan)
                                        .frame(width: max(2, 45.0 * CGFloat(Swift.min(m.sharePercent, 100.0) / 100.0)), height: 4)
                                }
                                .frame(width: 45)

                                Text(String(format: "%.1f%%", m.sharePercent))
                                    .font(.system(size: 7, design: .monospaced))
                                    .foregroundStyle(.white.opacity(0.6))
                                    .frame(width: 32, alignment: .trailing)
                            }
                            .padding(.horizontal, 6).padding(.vertical, 2.5)
                            .background(RoundedRectangle(cornerRadius: 3).fill(Color.white.opacity(0.025)))
                        }
                    }
                }
            }

            if !bd.tools.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Text("TELEMETRY TOOLS & PROVIDERS")
                        .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                        .foregroundStyle(.secondary)

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 4) {
                            ForEach(bd.tools.sorted(by: { $0.tokensAll > $1.tokensAll })) { t in
                                HStack(spacing: 4) {
                                    Circle().fill(DashboardTabs.toolColor(t.tool)).frame(width: 4, height: 4)
                                    Text(t.tool)
                                        .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                                        .foregroundStyle(.white.opacity(0.9))
                                    Text(UsageSnapshot.tokens(t.tokensToday > 0 ? t.tokensToday : t.tokensAll))
                                        .font(.system(size: 7.5, design: .monospaced))
                                        .foregroundStyle(Color.cyan)
                                }
                                .padding(.horizontal, 6).padding(.vertical, 2.5)
                                .background(RoundedRectangle(cornerRadius: 4).fill(Color.white.opacity(0.06)))
                            }
                        }
                    }
                }
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.045)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.cyan.opacity(0.25), lineWidth: 1))
    }

    private func userMetricBox(title: String, value: String, sub: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                .foregroundStyle(.tertiary)
            Text(value)
                .font(.system(size: 10, weight: .heavy, design: .monospaced))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(sub)
                .font(.system(size: 7, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 4).fill(Color.black.opacity(0.35)))
    }

    // MARK: - Share card preview

    private var shareCardPreview: some View {
        let cardText = LeaderboardStore.shared.generateShareCard(for: period, format: shareFormat, entryId: selected?.id)

        return VStack(alignment: .leading, spacing: 4) {
            sectionLabel("SHARE CARD PREVIEW · \(shareFormat.rawValue.uppercased())")
            ScrollView(.horizontal, showsIndicators: false) {
                Text(cardText)
                    .font(.system(size: 7.5, design: .monospaced))
                    .foregroundStyle(Color.white.opacity(0.85))
                    .textSelection(.enabled)
                    .padding(8)
            }
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.4)))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.1)))
        }
    }

    // MARK: - Helpers

    private func sectionLabel(_ s: String) -> some View {
        Text(s).font(.system(size: 8, weight: .heavy, design: .monospaced)).foregroundStyle(.tertiary).kerning(1)
    }

    private func tierColor(_ tier: LeagueTier?) -> Color {
        switch tier {
        case .bronze: return Color(red: 0.69, green: 0.47, blue: 0.29)
        case .silver: return Color(red: 0.68, green: 0.71, blue: 0.77)
        case .gold: return Color(red: 0.88, green: 0.71, blue: 0.30)
        case .platinum: return Color(red: 0.31, green: 0.76, blue: 0.97)
        case .diamond: return Color(red: 0.49, green: 0.42, blue: 0.96)
        case .master: return Color(red: 0.71, green: 0.30, blue: 0.94)
        case .grandmaster: return Color(red: 0.94, green: 0.27, blue: 0.42)
        case nil: return .gray
        }
    }

    private func romanDivision(_ division: Int) -> String {
        switch division {
        case 1: return "I"
        case 2: return "II"
        default: return "III"
        }
    }

    /// Last 30 published ranks as a Sparkline series, inverted so rank #1
    /// plots at the top (Sparkline fills upward from the baseline).
    private func rankTrendValues(_ entry: LeaderboardEntry?) -> [Double] {
        guard let entry else { return [] }
        let ranks = entry.snapshots.filter { $0.rank > 0 }.sorted { $0.day < $1.day }.suffix(30).map { $0.rank }
        guard ranks.count >= 2 else { return [] }
        let worst = Swift.max(ranks.max() ?? 1, 1)
        return ranks.map { Double(worst + 1 - $0) }
    }
}
