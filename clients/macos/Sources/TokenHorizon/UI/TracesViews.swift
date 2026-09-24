import SwiftUI

// TRACES tab — the local LLM observability surface. Reads gateway traces,
// session spans, and windowed stats through :8765 (GatewayBridge → sidecar).
// Cost estimates are enriched here from the model catalog; the gateway
// deliberately records null cost (no pricing dependency in the proxy path).

private enum TraceViewMode: String, CaseIterable, Identifiable {
    case traces = "TRACES", sessions = "SESSIONS", models = "MODELS"
    var id: String { rawValue }
}

private enum TraceWindow: Int, CaseIterable, Identifiable {
    case h1 = 1, h24 = 24, h168 = 168
    var id: Int { rawValue }
    var label: String { self == .h1 ? "1H" : self == .h24 ? "24H" : "7D" }
}

struct TracesTabView: View {
    @ObservedObject var store = TraceStore.shared
    @State private var mode: TraceViewMode = .traces
    @State private var window: TraceWindow = .h24
    @State private var providerFilter = ""
    @State private var clientFilter = ""
    @State private var errorsOnly = false
    @State private var sessionFilter = ""
    @State private var search = ""
    @State private var selectedTraceID: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            headerRow
            statsStrip
            Divider().overlay(Color.white.opacity(0.12))
            filterRow
            switch mode {
            case .traces: tracesList
            case .sessions: sessionsList
            case .models: modelsList
            }
        }
        .onAppear {
            store.windowHours = window.rawValue
            store.startPolling()
        }
        .onDisappear { store.stopPolling() }
        .sheet(item: Binding(
            get: { selectedTraceID.map(TraceSelection.init) },
            set: { selectedTraceID = $0?.id }
        )) { sel in
            TraceDetailView(id: sel.id)
        }
    }

    private struct TraceSelection: Identifiable { let id: String }

    // MARK: header + stats

    private var headerRow: some View {
        HStack {
            traceSectionLabel("LLM OBSERVABILITY")
            Spacer()
            if !store.online {
                MonospacedText(text: "GATEWAY OFFLINE", color: .orange, size: 8)
            } else {
                MonospacedText(
                    text: "\(store.memoryTraces) live · \(store.dayFiles)d · \(fmtBytes(store.storeBytes))",
                    color: .white.opacity(0.35), size: 8)
            }
            if let port = GatewaySupervisor.shared.port {
                MonospacedText(text: ":\(port)", color: .white.opacity(0.35), size: 8)
            }
            HStack(spacing: 4) {
                ForEach(TraceWindow.allCases) { w in
                    Button {
                        window = w
                        store.windowHours = w.rawValue
                        store.refresh()
                    } label: {
                        Text(w.label)
                            .font(.system(size: 8, weight: .heavy, design: .monospaced))
                            .foregroundStyle(window == w ? Color.black : Color.white.opacity(0.5))
                            .padding(.horizontal, 8).padding(.vertical, 2.5)
                            .background(Capsule().fill(window == w ? Color.white : Color.white.opacity(0.08)))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var statsStrip: some View {
        let s = store.stats
        let cost = modelCostTotal()
        return HStack(spacing: 12) {
            traceStat("reqs", "\(s?.requests ?? 0)", .white)
            traceStat("err", String(format: "%.0f%%", (s?.errorRate ?? 0) * 100),
                      (s?.errorCount ?? 0) > 0 ? .red : .secondary)
            traceStat("in", UsageSnapshot.tokens(s?.inputTokens ?? 0), .cyan)
            traceStat("out", UsageSnapshot.tokens(s?.outputTokens ?? 0), .green)
            traceStat("ttft", s?.avgTtftMs.map { String(format: "%.0fms", $0) } ?? "--", .orange)
            traceStat("p95", s?.p95DurationMs.map { fmtMs($0) } ?? "--", .purple)
            traceStat("cache", s?.cacheHitRate.map { String(format: "%.0f%%", $0 * 100) } ?? "--", .teal)
            if cost > 0 { traceStat("~$", fmtCost(cost), .yellow) }
            Spacer()
        }
    }

    private var filterRow: some View {
        HStack(spacing: 6) {
            HStack(spacing: 4) {
                ForEach(TraceViewMode.allCases) { m in
                    Button { mode = m } label: {
                        Text(m.rawValue)
                            .font(.system(size: 8, weight: .heavy, design: .monospaced))
                            .foregroundStyle(mode == m ? Color.black : Color.white.opacity(0.5))
                            .padding(.horizontal, 8).padding(.vertical, 2.5)
                            .background(Capsule().fill(mode == m ? Color.white : Color.white.opacity(0.08)))
                    }
                    .buttonStyle(.plain)
                }
            }
            // Provider pills: only providers that actually have traffic.
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    tracePill("all", active: providerFilter.isEmpty) { providerFilter = "" }
                    ForEach(activeProviders, id: \.self) { p in
                        tracePill(p, active: providerFilter == p) { providerFilter = providerFilter == p ? "" : p }
                    }
                }
            }
            Button {
                errorsOnly.toggle()
            } label: {
                Text("ERR")
                    .font(.system(size: 8, weight: .heavy, design: .monospaced))
                    .foregroundStyle(errorsOnly ? Color.black : .red.opacity(0.7))
                    .padding(.horizontal, 8).padding(.vertical, 2.5)
                    .background(Capsule().fill(errorsOnly ? Color.red : Color.white.opacity(0.08)))
            }
            .buttonStyle(.plain)
            if !sessionFilter.isEmpty {
                Button { sessionFilter = "" } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "link").font(.system(size: 7))
                        Text(shortKey(sessionFilter))
                            .font(.system(size: 8, weight: .heavy, design: .monospaced))
                        Image(systemName: "xmark").font(.system(size: 7))
                    }
                    .foregroundStyle(Color.black)
                    .padding(.horizontal, 8).padding(.vertical, 2.5)
                    .background(Capsule().fill(Color.teal))
                }
                .buttonStyle(.plain)
                .help("Filtering to session \(sessionFilter)")
            }
            HStack(spacing: 5) {
                Image(systemName: "magnifyingglass").font(.system(size: 8)).foregroundStyle(.white.opacity(0.4))
                TextField("model, client, path…", text: $search)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(.white)
                    .textFieldStyle(.plain)
                if !search.isEmpty {
                    Button { search = "" } label: {
                        Image(systemName: "xmark.circle.fill").font(.system(size: 9)).foregroundStyle(.white.opacity(0.4))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Capsule().fill(Color.white.opacity(0.08)))
            .frame(maxWidth: 200)
        }
    }

    // MARK: traces list

    private var filteredTraces: [GatewayTrace] {
        store.traces.filter { t in
            if !providerFilter.isEmpty && t.provider != providerFilter { return false }
            if !clientFilter.isEmpty && t.client != clientFilter { return false }
            if errorsOnly && !t.isError { return false }
            if !sessionFilter.isEmpty && t.sessionKey != sessionFilter { return false }
            if !search.isEmpty {
                let q = search.lowercased()
                let hay = [t.model, t.provider, t.client ?? "", t.path, t.endpoint, t.sessionKey ?? ""]
                    .joined(separator: " ").lowercased()
                if !hay.contains(q) { return false }
            }
            return true
        }
    }

    private var tracesList: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                MonospacedText(text: "TIME", color: .secondary, size: 7).frame(width: 34, alignment: .leading)
                MonospacedText(text: "SRC", color: .secondary, size: 7).frame(width: 16, alignment: .leading)
                MonospacedText(text: "MODEL", color: .secondary, size: 7).frame(maxWidth: .infinity, alignment: .leading)
                MonospacedText(text: "ST", color: .secondary, size: 7).frame(width: 28, alignment: .trailing)
                MonospacedText(text: "IN→OUT", color: .secondary, size: 7).frame(width: 72, alignment: .trailing)
                MonospacedText(text: "TTFT", color: .secondary, size: 7).frame(width: 44, alignment: .trailing)
                MonospacedText(text: "DUR", color: .secondary, size: 7).frame(width: 44, alignment: .trailing)
                MonospacedText(text: "T/S", color: .secondary, size: 7).frame(width: 36, alignment: .trailing)
            }
            .padding(.vertical, 3)
            Divider().overlay(Color.white.opacity(0.08))
            if !store.online && store.traces.isEmpty {
                gatewayOfflineHint
            } else if filteredTraces.isEmpty {
                MonospacedText(text: "no traces match — point a CLI at the gateway (OPENAI_BASE_URL / ANTHROPIC_BASE_URL → :port)", color: .secondary, size: 8)
                    .padding(.vertical, 12)
            } else {
                ForEach(filteredTraces) { t in
                    Button { selectedTraceID = t.id } label: {
                        traceRow(t)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func traceRow(_ t: GatewayTrace) -> some View {
        HStack(spacing: 6) {
            MonospacedText(text: t.startedDate.formatted(.dateTime.hour().minute().second()), color: .secondary, size: 7.5)
                .frame(width: 34, alignment: .leading)
            ProviderLogoView(provider: t.provider, model: t.model, size: 12)
                .frame(width: 16, alignment: .leading)
            HStack(spacing: 4) {
                MonospacedText(text: t.model, color: .white.opacity(0.85), size: 8)
                    .lineLimit(1).truncationMode(.middle)
                if let c = t.client, !c.isEmpty {
                    Text(c)
                        .font(.system(size: 6, weight: .heavy, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.5))
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .background(Capsule().fill(Color.white.opacity(0.1)))
                }
                if t.retrySuspect {
                    Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: 6)).foregroundStyle(.yellow.opacity(0.7))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            MonospacedText(text: t.isError ? (t.errorClass == "none" ? "err" : String(t.errorClass.prefix(8))) : "\(t.statusCode)",
                           color: t.isError ? .red : (t.statusCode < 300 ? .green : .orange), size: 7.5)
                .frame(width: 28, alignment: .trailing)
            MonospacedText(text: "\(UsageSnapshot.tokens(t.usage.inputTokens ?? 0))→\(UsageSnapshot.tokens(t.usage.outputTokens ?? 0))",
                           color: .white.opacity(0.7), size: 7.5)
                .frame(width: 72, alignment: .trailing)
            MonospacedText(text: t.ttftMs.map { fmtMs($0) } ?? "--", color: .orange, size: 7.5)
                .frame(width: 44, alignment: .trailing)
            MonospacedText(text: fmtMs(t.durationMs), color: .white.opacity(0.6), size: 7.5)
                .frame(width: 44, alignment: .trailing)
            MonospacedText(text: t.tokPerSec.map { String(format: "%.0f", $0) } ?? "--", color: .green, size: 7.5)
                .frame(width: 36, alignment: .trailing)
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
    }

    // MARK: sessions list

    private var sessionsList: some View {
        VStack(alignment: .leading, spacing: 0) {
            if store.sessions.isEmpty {
                MonospacedText(text: "no sessions — clients must send a session key (codex session_id, anthropic metadata.user_id, x-session-id)", color: .secondary, size: 8)
                    .padding(.vertical, 12)
            } else {
                ForEach(store.sessions) { s in
                    Button {
                        sessionFilter = s.sessionKey
                        mode = .traces
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "link").font(.system(size: 7)).foregroundStyle(.teal)
                            MonospacedText(text: shortKey(s.sessionKey), color: .white.opacity(0.85), size: 8)
                                .frame(width: 90, alignment: .leading)
                            ForEach(s.clients, id: \.self) { c in
                                Text(c).font(.system(size: 6, weight: .heavy, design: .monospaced))
                                    .foregroundStyle(.white.opacity(0.5))
                                    .padding(.horizontal, 4).padding(.vertical, 1)
                                    .background(Capsule().fill(Color.white.opacity(0.1)))
                            }
                            MonospacedText(text: s.models.prefix(2).joined(separator: ","), color: .secondary, size: 7.5)
                                .lineLimit(1).truncationMode(.middle)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            if s.errorCount > 0 {
                                MonospacedText(text: "\(s.errorCount)err", color: .red, size: 7.5)
                            }
                            MonospacedText(text: "\(s.requests)rq", color: .white.opacity(0.7), size: 7.5).frame(width: 30, alignment: .trailing)
                            MonospacedText(text: UsageSnapshot.tokens(s.inputTokens + s.outputTokens), color: .green, size: 7.5).frame(width: 44, alignment: .trailing)
                            MonospacedText(text: fmtSpan(s.spanMs), color: .secondary, size: 7.5).frame(width: 44, alignment: .trailing)
                            MonospacedText(text: s.lastDate.formatted(.dateTime.hour().minute()), color: .secondary, size: 7.5).frame(width: 34, alignment: .trailing)
                        }
                        .padding(.vertical, 3)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: models list

    private var modelsList: some View {
        VStack(alignment: .leading, spacing: 0) {
            let rows = store.stats?.byModel ?? []
            if rows.isEmpty {
                MonospacedText(text: "no model traffic in window", color: .secondary, size: 8).padding(.vertical, 12)
            } else {
                ForEach(rows) { m in
                    HStack(spacing: 6) {
                        ProviderLogoView(provider: m.provider, model: m.model, size: 12)
                        MonospacedText(text: m.model, color: .white.opacity(0.85), size: 8)
                            .lineLimit(1).truncationMode(.middle)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        MonospacedText(text: m.provider, color: .secondary, size: 7.5).frame(width: 52, alignment: .trailing)
                        if m.errorCount > 0 {
                            MonospacedText(text: "\(m.errorCount)err", color: .red, size: 7.5).frame(width: 30, alignment: .trailing)
                        }
                        MonospacedText(text: "\(m.requests)rq", color: .white.opacity(0.7), size: 7.5).frame(width: 34, alignment: .trailing)
                        MonospacedText(text: "\(UsageSnapshot.tokens(m.inputTokens))→\(UsageSnapshot.tokens(m.outputTokens))",
                                       color: .white.opacity(0.6), size: 7.5).frame(width: 80, alignment: .trailing)
                        MonospacedText(text: m.avgTtftMs.map { fmtMs($0) } ?? "--", color: .orange, size: 7.5).frame(width: 44, alignment: .trailing)
                        MonospacedText(text: m.avgTokPerSec.map { String(format: "%.0f t/s", $0) } ?? "--", color: .green, size: 7.5).frame(width: 48, alignment: .trailing)
                        if let cost = store.estimatedCost(provider: m.provider, model: m.model,
                                                          input: m.inputTokens, output: m.outputTokens, cached: m.cachedTokens), cost > 0 {
                            MonospacedText(text: fmtCost(cost), color: .yellow, size: 7.5).frame(width: 44, alignment: .trailing)
                        } else {
                            MonospacedText(text: "--", color: .secondary, size: 7.5).frame(width: 44, alignment: .trailing)
                        }
                    }
                    .padding(.vertical, 3)
                }
            }
            if let errs = store.stats?.byError, !errs.isEmpty {
                Divider().overlay(Color.white.opacity(0.12)).padding(.vertical, 6)
                traceSectionLabel("ERROR CLASSES")
                HStack(spacing: 8) {
                    ForEach(errs) { e in
                        MonospacedText(text: "\(e.class) ×\(e.count)", color: .red.opacity(0.8), size: 8)
                    }
                    Spacer()
                }
            }
            if let clients = store.stats?.byClient, !clients.isEmpty {
                Divider().overlay(Color.white.opacity(0.12)).padding(.vertical, 6)
                traceSectionLabel("CLIENTS")
                HStack(spacing: 8) {
                    ForEach(clients) { c in
                        Button { clientFilter = clientFilter == c.client ? "" : c.client; mode = .traces } label: {
                            MonospacedText(text: "\(c.client) ×\(c.requests)", color: .cyan.opacity(0.8), size: 8)
                        }
                        .buttonStyle(.plain)
                    }
                    Spacer()
                }
            }
        }
    }

    // MARK: helpers

    private var activeProviders: [String] {
        var seen = Set<String>()
        var out: [String] = []
        for t in store.traces {
            if seen.insert(t.provider).inserted { out.append(t.provider) }
        }
        for p in (store.stats?.byProvider ?? []).map(\.provider) {
            if seen.insert(p).inserted { out.append(p) }
        }
        return out.sorted()
    }

    private func modelCostTotal() -> Double {
        var total = 0.0
        for m in store.stats?.byModel ?? [] {
            if let c = store.estimatedCost(provider: m.provider, model: m.model,
                                           input: m.inputTokens, output: m.outputTokens, cached: m.cachedTokens) {
                total += c
            }
        }
        return total
    }

    private var gatewayOfflineHint: some View {
        VStack(alignment: .leading, spacing: 6) {
            MonospacedText(text: "gateway not reachable", color: .orange, size: 9)
            MonospacedText(text: "the sidecar starts with the app; route clients with env vars:", color: .secondary, size: 8)
            MonospacedText(text: "  OPENAI_BASE_URL=http://127.0.0.1:\(GatewaySupervisor.shared.port ?? 11436)", color: .white.opacity(0.5), size: 7.5)
            MonospacedText(text: "  ANTHROPIC_BASE_URL=http://127.0.0.1:\(GatewaySupervisor.shared.port ?? 11436)", color: .white.opacity(0.5), size: 7.5)
            MonospacedText(text: "  other providers: …/th-kimi /th-glm /th-minimax /th-deepseek /th-qwen /th-grok /th-gemini /th-opencode", color: .white.opacity(0.4), size: 7.5)
        }
        .padding(.vertical, 12)
    }

    private func traceSectionLabel(_ s: String) -> some View {
        Text(s).font(.system(size: 8, weight: .heavy, design: .monospaced)).foregroundStyle(.tertiary).kerning(1)
    }
    private func traceStat(_ label: String, _ value: String, _ color: Color) -> some View {
        HStack(spacing: 4) {
            Text(label).font(.system(size: 9, design: .monospaced)).foregroundStyle(.secondary)
            MonospacedText(text: value, color: color, size: 9)
        }
    }
    private func tracePill(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                .foregroundStyle(active ? Color.black : Color.white.opacity(0.55))
                .padding(.horizontal, 7).padding(.vertical, 2.5)
                .background(Capsule().fill(active ? Color.white : Color.white.opacity(0.08)))
        }
        .buttonStyle(.plain)
    }

    private func shortKey(_ key: String) -> String {
        if key.count <= 16 { return key }
        return String(key.suffix(12))
    }
    private func fmtMs(_ ms: Double) -> String {
        ms >= 1000 ? String(format: "%.1fs", ms / 1000) : String(format: "%.0fms", ms)
    }
    private func fmtSpan(_ ms: Double) -> String {
        if ms >= 3_600_000 { return String(format: "%.1fh", ms / 3_600_000) }
        if ms >= 60_000 { return String(format: "%.0fm", ms / 60_000) }
        return fmtMs(ms)
    }
    private func fmtCost(_ usd: Double) -> String {
        usd >= 1 ? String(format: "$%.2f", usd) : String(format: "$%.3f", usd)
    }
    private func fmtBytes(_ b: Int64) -> String {
        b >= 1_048_576 ? String(format: "%.0fMB", Double(b) / 1_048_576) : String(format: "%.0fKB", Double(b) / 1024)
    }
}

// TraceDetailView loads the full trace (bodies included) from /traces/<id>.
private struct TraceDetailView: View {
    let id: String
    @State private var trace: GatewayTrace? = nil
    @State private var failed = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("TRACE")
                    .font(.system(size: 9, weight: .heavy, design: .monospaced)).foregroundStyle(.tertiary).kerning(1)
                if let t = trace {
                    MonospacedText(text: t.id, color: .secondary, size: 8)
                }
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 12)).foregroundStyle(.white.opacity(0.4))
                }
                .buttonStyle(.plain)
            }
            if let t = trace {
                metaGrid(t)
                if let msg = t.errorMessage {
                    MonospacedText(text: "error: \(msg)", color: .red, size: 8).fixedSize(horizontal: false, vertical: true)
                }
                if !t.toolCalls.isEmpty {
                    traceLabel("TOOL CALLS")
                    ForEach(t.toolCalls) { call in
                        MonospacedText(text: "→ \(call.name)\(call.callId.map { " (\($0))" } ?? "")", color: .cyan, size: 8)
                    }
                }
                if !t.finishReasons.isEmpty {
                    MonospacedText(text: "finish: \(t.finishReasons.joined(separator: ", "))", color: .secondary, size: 8)
                }
                bodySection("REQUEST", t.requestBody, truncated: t.requestTruncated)
                bodySection("RESPONSE", t.responseBody, truncated: t.responseTruncated)
                Spacer(minLength: 0)
            } else if failed {
                MonospacedText(text: "trace not found (ring holds the newest 200; older live only in JSONL day files)", color: .secondary, size: 9)
                Spacer(minLength: 0)
            } else {
                ProgressView().controlSize(.small)
                Spacer(minLength: 0)
            }
        }
        .padding(14)
        .frame(minWidth: 480, minHeight: 320)
        .task { await load() }
    }

    private func metaGrid(_ t: GatewayTrace) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 10) {
                ProviderLogoView(provider: t.provider, model: t.model, size: 14)
                MonospacedText(text: "\(t.provider)/\(t.endpoint)", color: .white.opacity(0.8), size: 8)
                MonospacedText(text: t.model, color: .cyan, size: 8)
                if let c = t.client, !c.isEmpty { MonospacedText(text: "via \(c)", color: .secondary, size: 8) }
                Spacer()
                MonospacedText(text: "\(t.statusCode)", color: t.isError ? .red : .green, size: 8)
            }
            HStack(spacing: 10) {
                MonospacedText(text: t.startedDate.formatted(.dateTime.hour().minute().second().secondFraction(.fractional(3))), color: .secondary, size: 8)
                MonospacedText(text: "ttft \(t.ttftMs.map { String(format: "%.0fms", $0) } ?? "--")", color: .orange, size: 8)
                MonospacedText(text: "dur \(String(format: "%.0fms", t.durationMs))", color: .secondary, size: 8)
                MonospacedText(text: t.stream ? "stream" : "unary", color: .secondary, size: 8)
                if t.retrySuspect { MonospacedText(text: "retry?", color: .yellow, size: 8) }
            }
            HStack(spacing: 10) {
                MonospacedText(text: "in \(t.usage.inputTokens.map(String.init) ?? "–") out \(t.usage.outputTokens.map(String.init) ?? "–") cached \(t.usage.cachedTokens.map(String.init) ?? "–") (\(t.usage.source))",
                               color: .secondary, size: 8)
                if let rid = t.providerRequestId { MonospacedText(text: "rid \(rid)", color: .white.opacity(0.4), size: 7.5) }
            }
            if let sk = t.sessionKey {
                MonospacedText(text: "session \(sk)", color: .teal, size: 7.5).lineLimit(1).truncationMode(.middle)
            }
            MonospacedText(text: t.path, color: .white.opacity(0.4), size: 7.5).lineLimit(1).truncationMode(.middle)
        }
    }

    private func bodySection(_ label: String, _ body: String?, truncated: Bool) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                traceLabel(label + (truncated ? " (truncated)" : ""))
                Spacer()
                if let body {
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(body, forType: .string)
                    } label: {
                        Image(systemName: "doc.on.doc").font(.system(size: 8)).foregroundStyle(.white.opacity(0.4))
                    }
                    .buttonStyle(.plain)
                }
            }
            if let body, !body.isEmpty {
                ScrollView {
                    Text(body)
                        .font(.system(size: 7.5, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.7))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 140)
                .padding(6)
                .background(RoundedRectangle(cornerRadius: 5).fill(Color.white.opacity(0.05)))
            } else {
                MonospacedText(text: "—", color: .secondary, size: 8)
            }
        }
    }

    private func traceLabel(_ s: String) -> some View {
        Text(s).font(.system(size: 7.5, weight: .heavy, design: .monospaced)).foregroundStyle(.tertiary).kerning(1)
    }

    private func load() async {
        guard let url = URL(string: "http://127.0.0.1:8765/traces/\(id)") else { failed = true; return }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            trace = try JSONDecoder().decode(GatewayTrace.self, from: data)
        } catch {
            failed = true
        }
    }
}
