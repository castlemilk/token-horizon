import SwiftUI

/// ENGINE tab — local inference platform. Three supervised backends:
/// TH Engine (our Rust/candle sidecar, :8001), Splash (incoai's specialised
/// engine, :8000) and MLX (Apple's mlx-lm server, :8002). All state comes
/// from EngineManager → per-backend supervisors (which probe the engines
/// themselves); this view never invents status.
struct EngineTabView: View {
    @ObservedObject private var mgr = EngineManager.shared
    @State private var backend = "thengine"
    @State private var overrides = false
    @State private var memDraft = ""
    @State private var ctxDraft = ""
    @State private var keepLoaded = false
    @State private var chatPrompt = ""
    @State private var chatReply = ""
    @State private var chatBusy = false
    @State private var progressTimer: Timer?

    private let machine = HardwareProfile.probe()

    private var sup: BackendSupervisor {
        mgr.supervisor(for: backend) ?? mgr.splash
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            backendPicker
            statusCard
            recommendedCard
            catalogueCard
            chatCard
            benchCard
            connectCard
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .onReceive(mgr.splash.$state) { _ in tickProgress() }
        .onReceive(mgr.thengine.$state) { _ in tickProgress() }
        .onReceive(mgr.mlx.$state) { _ in tickProgress() }
        .onDisappear { progressTimer?.invalidate() }
    }

    // MARK: - Download progress

    /// While an engine is starting, the hub's partial blobs are the ground
    /// truth for the download; poll them so the row shows real progress.
    private func tickProgress() {
        guard sup.state.isBusy else { progressTimer?.invalidate(); return }
        if progressTimer == nil {
            let mgr = self.mgr
            let t = Timer(timeInterval: 1.0, repeats: true) { _ in
                mgr.objectWillChange.send()
            }
            RunLoop.main.add(t, forMode: .common)
            progressTimer = t
        }
    }

    // MARK: - Recommended for this machine

    /// The catalogue reconciled against this machine: what can run here, best
    /// options first, with the serve ceilings the engine's own analysis picks.
    private var recommendedCard: some View {
        let recs = LocalModelCatalog.recommendations(for: machine, engine: backend, limit: 5)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("RECOMMENDED FOR THIS MACHINE")
                    .font(.system(size: 9, weight: .heavy, design: .monospaced))
                    .foregroundStyle(.tertiary).kerning(1)
                Spacer()
                Text("\(HardwareProfile.probe().chipName) · \(Int(machine.physicalMemoryGB)) GB")
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.35))
            }
            if recs.isEmpty {
                Text("No model in the catalogue fits this machine.")
                    .font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
            } else {
                ForEach(Array(recs.enumerated()), id: \.element.model.modelSpec) { index, rec in
                    recommendedRow(rec, rank: index + 1)
                }
            }
            Text("Sizes are the download from the Hugging Face hub; the engine fetches them on first run and the model stays cached.")
                .font(.system(size: 7.5, design: .monospaced))
                .foregroundStyle(.white.opacity(0.28))
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.03)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.06), lineWidth: 1))
    }

    private func recommendedRow(_ rec: LocalModelCatalog.Recommendation, rank: Int) -> some View {
        let serving = sup.state.isServing || sup.state.isBusy
        let activeModel = sup.state.currentModel
        let isThis = activeModel == rec.model.modelSpec || activeModel == rec.model.id
        let installed = HFModelStore.isInstalled(rec.model.id)
        let progress = sup.state.isBusy && isThis
            ? HFModelStore.progress(rec.model.id, expectedGB: rec.model.sizeGB) : nil
        return HStack(alignment: .top, spacing: 10) {
            Text("\(rank)")
                .font(.system(size: 9, weight: .heavy, design: .monospaced))
                .foregroundStyle(rank == 1 ? .green : .white.opacity(0.3))
                .frame(width: 12)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(rec.model.name)
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .foregroundStyle(isThis ? .green : .white)
                    Text(rec.fit.badge)
                        .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Capsule().fill(fitColor(rec.fit).opacity(0.18)))
                        .foregroundStyle(fitColor(rec.fit))
                    if installed {
                        Text("INSTALLED")
                            .font(.system(size: 7, weight: .heavy, design: .monospaced))
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Capsule().fill(Color.blue.opacity(0.18)))
                            .foregroundStyle(.blue)
                    }
                    if let t = rec.model.capabilities.first {
                        Text(t.uppercased())
                            .font(.system(size: 7, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.35))
                    }
                }
                if let progress {
                    VStack(alignment: .leading, spacing: 2) {
                        ProgressView(value: progress.fraction)
                            .progressViewStyle(.linear)
                            .tint(.green)
                        Text("\(String(format: "%.1f", progress.downloadedGB)) / \(String(format: "%.1f", progress.totalGB)) GB downloading")
                            .font(.system(size: 8, design: .monospaced))
                            .foregroundStyle(.green.opacity(0.8))
                    }
                } else {
                    Text(rec.reasons.prefix(2).joined(separator: " · "))
                        .font(.system(size: 8.5, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                HStack(spacing: 10) {
                    Text("\(rec.tokPerSecMeasured ? "" : "~")\(String(format: "%.0f", rec.tokPerSec)) tok/s\(rec.tokPerSecMeasured ? "" : " est")")
                        .foregroundStyle(rec.tokPerSec < HardwareMap.interactiveFloor ? .orange : .white.opacity(0.45))
                    Text("\(String(format: "%.1f", rec.model.sizeGB)) GB download")
                    Text("\(rec.model.contextK / 1000)M ctx")
                    Text("ceiling \(rec.maxContextK)K @ \(rec.maxMemoryGB) GB")
                }
                .font(.system(size: 8, design: .monospaced))
                .foregroundStyle(.white.opacity(0.35))
            }
            Spacer()
            Button(isThis ? "SERVING" : "RUN") {
                sup.serve(model: rec.model.modelSpec,
                          tokenizer: rec.model.engine == "thengine" ? rec.model.tokenizer : nil,
                          maxMemoryGB: rec.maxMemoryGB, maxContextK: rec.maxContextK)
            }
            .font(.system(size: 10, weight: .heavy, design: .monospaced))
            .foregroundStyle(isThis ? .black : .green)
            .padding(.horizontal, 12).padding(.vertical, 4)
            .background(Capsule().fill(isThis ? Color.white.opacity(0.9) : Color.green))
            .buttonStyle(.plain)
            .disabled(serving || !sup.engineAvailable)
            .help("Download if needed, then serve — traced at http://127.0.0.1:11436/\(gatewaySlug)")
        }
        .padding(.vertical, 2)
    }

    // MARK: - Chat

    /// A minimal client pointed at the gateway's traced local route: what you
    /// type runs on the served model and lands in /traces like any other call.
    private var chatCard: some View {
        let serving = sup.state.isServing
        return VStack(alignment: .leading, spacing: 8) {
            Text("CHAT").font(.system(size: 10, weight: .heavy, design: .monospaced))
                .foregroundStyle(.white.opacity(0.5))
            if let reply = chatReply.isEmpty ? nil : chatReply {
                ScrollView(.vertical, showsIndicators: false) {
                    Text(reply)
                        .font(.system(size: 9.5, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.85))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 120)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
            }
            HStack(spacing: 8) {
                TextField(serving ? "Message \(sup.state.currentModel ?? "the model")…" : "Serve a model to chat",
                          text: $chatPrompt)
                    .textFieldStyle(.plain)
                    .font(.system(size: 10, design: .monospaced))
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.4)))
                    .onSubmit { sendChat() }
                    .disabled(!serving || chatBusy)
                Button(chatBusy ? "…" : "SEND") { sendChat() }
                    .font(.system(size: 10, weight: .heavy, design: .monospaced))
                    .foregroundStyle(.black)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(Capsule().fill(serving && !chatBusy ? Color.cyan : Color.white.opacity(0.2)))
                    .buttonStyle(.plain)
                    .disabled(!serving || chatBusy)
            }
            if chatBusy {
                Text("waiting on \(sup.state.currentModel ?? "model")…")
                    .font(.system(size: 8, design: .monospaced)).foregroundStyle(.white.opacity(0.35))
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.03)))
    }

    /// Subscript a JSON dictionary by key path: ["choices", 0, "message", "content"].
    private static func jsonPath(_ obj: [String: Any]?, _ path: [Any]) -> Any? {
        guard let obj else { return nil }
        var cur: Any = obj
        for step in path {
            if let idx = step as? Int, let list = cur as? [Any], list.indices.contains(idx) {
                cur = list[idx]
            } else if let key = step as? String, let dict = cur as? [String: Any] {
                cur = dict[key] ?? NSNull()
            } else {
                return nil
            }
            if cur is NSNull { return nil }
        }
        return cur
    }

    /// The gateway's traced route for the selected engine.
    private var gatewaySlug: String {
        switch backend {
        case "splash": return "th-splash"
        case "mlx": return "th-mlx"
        default: return "th-engine"
        }
    }

    private func sendChat() {
        let prompt = chatPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, !chatBusy else { return }
        chatBusy = true
        chatPrompt = ""
        let model = sup.state.currentModel ?? backend
        let path = gatewaySlug
        var req = URLRequest(url: URL(string: "http://127.0.0.1:11436/\(path)/v1/chat/completions")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "model": model,
            "messages": [["role": "user", "content": prompt]],
        ])
        URLSession.shared.dataTask(with: req) { data, _, _ in
            defer { DispatchQueue.main.async { chatBusy = false } }
            let text = Self.jsonPath((try? JSONSerialization.jsonObject(with: data ?? Data())) as? [String: Any],
                                     ["choices", 0, "message", "content"]) as? String
            DispatchQueue.main.async {
                chatReply = text ?? (data.flatMap { String(data: $0, encoding: .utf8) } ?? "no response")
            }
        }.resume()
    }

    // MARK: - Backend picker

    private var backendPicker: some View {
        HStack(spacing: 4) {
            ForEach(LocalModelCatalog.engines(), id: \.self) { b in
                Button(LocalModelCatalog.engineLabel(b)) { backend = b }
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(backend == b ? .black : .white.opacity(0.5))
                    .padding(.horizontal, 12).padding(.vertical, 5)
                    .background(Capsule().fill(backend == b ? .white : .white.opacity(0.08)))
                    .buttonStyle(.plain)
            }
            Spacer()
            // per-backend availability dot
            ForEach(LocalModelCatalog.engines(), id: \.self) { b in
                Circle()
                    .fill((mgr.supervisor(for: b)?.state.isServing ?? false)
                          ? .green : .white.opacity(0.15))
                    .frame(width: 6, height: 6)
                Text(b)
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.35))
            }
        }
    }

    // MARK: - Status

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 8, height: 8)
                Text(statusTitle)
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                Spacer()
                if canStop {
                    Button("STOP") { sup.stop() }
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundStyle(.red.opacity(0.9))
                        .buttonStyle(.plain)
                }
            }

            Toggle("Keep model loaded until stopped", isOn: $keepLoaded)
                .toggleStyle(.checkbox)
                .font(.system(size: 10))
                .disabled(sup.state.isServing || sup.state.isBusy)
            if !keepLoaded {
                Stepper(value: idleTimeoutBinding, in: 30...3600, step: 30) {
                    Text("Idle unload after \(idleText(SettingsStore.shared.engineIdleTimeoutSecs))")
                        .font(.system(size: 10))
                }
                .disabled(sup.state.isServing || sup.state.isBusy)
            }
            Text(engineLifecycleText)
                .font(.system(size: 10))
                .foregroundStyle(.white.opacity(0.45))

            if case .failed(let reason) = sup.state {
                Text(reason)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.red.opacity(0.8))
                    .lineLimit(3)
            }

            if !sup.engineAvailable, let hint = sup.installHint {
                Text(hint)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.yellow.opacity(0.85))
            }

            if backend == "splash",
               let blocker = HardwareProfile.eligibilityBlocker(machine) {
                Label(blocker, systemImage: "exclamationmark.triangle")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.yellow)
            }

            // Live engine stats when serving
            if let s = sup.status {
                HStack(spacing: 14) {
                    if backend == "splash" {
                        if let m = s["metrics"] as? [String: Any],
                           let tps = m["decode_tokens_per_second"] as? NSNumber {
                            metric("DECODE", String(format: "%.0f tok/s", tps.doubleValue))
                        }
                        if let mem = s["memory_actual"] as? [String: Any],
                           let cur = mem["current_bytes"] as? NSNumber {
                            metric("GPU MEM", String(format: "%.1f GiB", cur.doubleValue / 1_073_741_824))
                        }
                    } else {
                        if let m = s["metrics"] as? [String: Any],
                           let tps = m["decode_tps"] as? NSNumber {
                            metric("DECODE", String(format: "%.0f tok/s", tps.doubleValue))
                        }
                        if let rss = s["rss_bytes"] as? NSNumber {
                            metric("RSS", String(format: "%.1f GiB", rss.doubleValue / 1_073_741_824))
                        }
                    }
                    if let ctx = s["maximum_context_tokens"] as? NSNumber {
                        metric("CONTEXT", "\(ctx.intValue / 1024)K")
                    }
                    if let req = s["requests"] as? [String: Any],
                       let done = req["completed"] as? NSNumber {
                        metric("REQUESTS", "\(done.intValue)")
                    }
                }
            }

            HStack(spacing: 6) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 9))
                    .foregroundStyle(.white.opacity(0.4))
                Text("\(machine.chipName) · \(Int(machine.physicalMemoryGB)) GB · macOS \(machine.macosMajor).\(machine.macosMinor)")
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.45))
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.05)))
    }

    private var canStop: Bool {
        switch sup.state {
        case .starting, .serving(_, _, false): return true
        default: return false
        }
    }

    private var idleTimeoutBinding: Binding<Double> {
        Binding(
            get: { Double(max(30, SettingsStore.shared.engineIdleTimeoutSecs)) },
            set: { SettingsStore.shared.engineIdleTimeoutSecs = Int($0) })
    }

    private func idleText(_ secs: Int) -> String {
        secs >= 120 ? "\(secs / 60) min" : "\(secs) seconds"
    }

    /// memgov readout — th-engine's /status `memory` section (absent on
    /// splash/mlx, where the key simply never appears and this is "").
    private func memNote() -> String {
        guard let m = sup.status?["memory"] as? [String: Any],
              let w = (m["weights_alloc_bytes"] as? NSNumber)?.doubleValue,
              w > 0 else { return "" }
        let gb = String(format: "%.1f GB", w / 1_073_741_824)
        if let pressure = (m["pressure"] as? NSNumber)?.doubleValue, pressure > 0 {
            return " · weights \(gb) · mem \(Int((pressure * 100).rounded()))%"
        }
        if let admission = m["admission"] as? String, admission == "exceeds" {
            return " · weights \(gb) · over device limit"
        }
        return " · weights \(gb)"
    }

    private var engineLifecycleText: String {
        if case .serving(_, _, let attached) = sup.state {
            if attached {
                return "Started outside Token Horizon. Stop it in the app or terminal that launched it."
            }
            let p = sup.payload()
            let pinned = (sup.status?["lifecycle"] as? [String: Any])?["keep_loaded"] as? Bool
                ?? (p["keep_loaded"] as? Bool ?? keepLoaded)
            let secs = p["idle_timeout_secs"] as? Int
                ?? SettingsStore.shared.engineIdleTimeoutSecs
            if pinned || secs <= 0 {
                return "Loaded until you stop it."
            }
            let idle = p["idle_seconds"] as? Int ?? 0
            return "Idle \(idle)s — releases memory after \(idleText(secs)) without inference.\(memNote())"
        }
        let secs = SettingsStore.shared.engineIdleTimeoutSecs
        return (keepLoaded || secs <= 0)
            ? "Starts when you press Serve and stays loaded until you stop it."
            : "Starts when you press Serve. Releases memory after \(idleText(secs)) without inference."
    }

    private var statusColor: Color {
        switch sup.state {
        case .serving: return .green
        case .starting: return .blue
        case .failed: return .red
        case .stopped: return .gray.opacity(0.5)
        }
    }

    private var statusTitle: String {
        let name = LocalModelCatalog.engineLabel(backend)
        switch sup.state {
        case .serving(let model, _, let attached):
            return "\(name) · \(model.split(separator: "/").last.map(String.init) ?? model)\(attached ? " (attached)" : "")"
        case .starting(let model):
            return "\(name) · STARTING \(model.split(separator: "/").last.map(String.init) ?? model)…"
        case .failed:
            return "\(name) FAILED"
        case .stopped:
            return "\(name) STOPPED"
        }
    }

    private func metric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.system(size: 8, weight: .bold, design: .monospaced))
                .foregroundStyle(.white.opacity(0.35))
            Text(value).font(.system(size: 12, weight: .semibold, design: .monospaced))
                .foregroundStyle(.white.opacity(0.9))
        }
    }

    // MARK: - Full catalogue

    /// Every catalogue row the selected engine can serve on this machine — the
    /// full list behind the top-five card, each with the engine's own fit,
    /// measured-or-estimated throughput, and its serve ceilings.
    private var catalogueCard: some View {
        let recs = LocalModelCatalog.runnable(for: machine, engine: backend)
        let installed = recs.filter { HFModelStore.isInstalled($0.model.id) }.count
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("ALL MODELS · \(LocalModelCatalog.engineLabel(backend))")
                    .font(.system(size: 10, weight: .heavy, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.5))
                Text("\(recs.count) run here · \(installed) installed")
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.3))
                Spacer()
                catalogTuningButton
            }
            if overrides { overrideFields }
            if recs.isEmpty {
                Text(emptyCatalogueText)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(recs, id: \.model.modelSpec) { rec in
                    catalogueRow(rec)
                }
            }
            Text(engineFooterText)
                .font(.system(size: 8, design: .monospaced))
                .foregroundStyle(.white.opacity(0.3))
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.05)))
    }

    private var catalogTuningButton: some View {
        Button(overrides ? "auto-tuned" : "customize") { overrides.toggle() }
            .font(.system(size: 9, design: .monospaced))
            .foregroundStyle(.white.opacity(0.4))
            .buttonStyle(.plain)
    }

    private var overrideFields: some View {
        HStack(spacing: 8) {
            TextField("max mem GB", text: $memDraft)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 10, design: .monospaced))
                .frame(width: 90)
            TextField("max ctx K", text: $ctxDraft)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 10, design: .monospaced))
                .frame(width: 90)
        }
    }

    private var emptyCatalogueText: String {
        switch backend {
        case "splash":
            return "No Splash package fits this machine — Splash needs M3+, macOS 26.4 and 36 GB."
        case "mlx":
            return "No MLX checkpoint fits this machine."
        default:
            return "No model in the catalogue fits this machine."
        }
    }

    private var engineFooterText: String {
        switch backend {
        case "splash":
            return "Splash serves packaged models only — any owner/repo holding a Splash package works too."
        case "mlx":
            return "mlx-lm serves any mlx-community checkpoint — this is the curated 4-bit set, not a limit."
        default:
            return "TH Engine serves any single-file GGUF (qwen2/qwen3/llama) or MLX 4-bit qwen3_5 repo via the API with an explicit model spec."
        }
    }

    private func catalogueRow(_ rec: LocalModelCatalog.Recommendation) -> some View {
        let serving = sup.state.isServing || sup.state.isBusy
        let isThis = sup.state.currentModel == rec.model.modelSpec
            || sup.state.currentModel == rec.model.id
        let installed = HFModelStore.isInstalled(rec.model.id)
        return HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(rec.model.name)
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .foregroundStyle(isThis ? .green : .white.opacity(0.9))
                    if installed {
                        Text("INSTALLED")
                            .font(.system(size: 7, weight: .heavy, design: .monospaced))
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Capsule().fill(Color.blue.opacity(0.18)))
                            .foregroundStyle(.blue)
                    }
                }
                Text("\(String(format: "%.1f", rec.model.sizeGB)) GB · \(rec.model.quant) · \(rec.model.contextK / 1000)M ctx · \(String(format: "%.0f", rec.tokPerSec)) tok/s\(rec.tokPerSecMeasured ? "" : " est") · ceiling \(rec.maxContextK)K @ \(rec.maxMemoryGB) GB")
                    .font(.system(size: 8.5, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.4))
                    .lineLimit(2)
            }
            Spacer()
            Text(rec.fit.badge)
                .font(.system(size: 8, weight: .bold, design: .monospaced))
                .foregroundStyle(fitColor(rec.fit))
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Capsule().fill(fitColor(rec.fit).opacity(0.15)))
            serveButton(enabled: !serving && sup.engineAvailable) {
                sup.serve(model: rec.model.modelSpec,
                          tokenizer: rec.model.engine == "thengine" ? rec.model.tokenizer : nil,
                          maxMemoryGB: overrides ? Int(memDraft) : rec.maxMemoryGB,
                          maxContextK: overrides ? Int(ctxDraft) : rec.maxContextK,
                          keepLoaded: keepLoaded)
            }
        }
    }

    private func fitColor(_ f: HardwareProfile.Fit) -> Color {
        switch f {
        case .unsupported: return .red
        case .tight: return .orange
        case .comfortable: return .green
        case .generous: return .cyan
        }
    }

    private func serveButton(enabled: Bool, action: @escaping () -> Void) -> some View {
        Button("SERVE", action: action)
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .foregroundStyle(.black)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(Capsule().fill(enabled ? Color.white : Color.white.opacity(0.2)))
            .buttonStyle(.plain)
            .disabled(!enabled)
    }

    // MARK: - Benchmarks

    private var benchCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("BENCHMARK").font(.system(size: 10, weight: .heavy, design: .monospaced))
                .foregroundStyle(.white.opacity(0.5))
            if let b = mgr.bench {
                benchSummary(b)
            } else {
                Text("No results yet — run scripts/bench-engines.sh")
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.35))
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.05)))
    }

    private func benchSummary(_ b: [String: Any]) -> some View {
        // bench file is {latest: {...}, runs: [...]} — show the latest run.
        let run = (b["latest"] as? [String: Any]) ?? b
        return VStack(alignment: .leading, spacing: 4) {
            if let when = run["ran_at"] as? String {
                Text("last run \(when)")
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.3))
            }
            if let engines = b["engines"] as? [String: [String: Any]] {
                ForEach(engines.keys.sorted(), id: \.self) { key in
                    if let e = engines[key] {
                        HStack(spacing: 10) {
                            Text(key)
                                .font(.system(size: 9, weight: .bold, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.8))
                                .frame(width: 70, alignment: .leading)
                            if let d = e["decode_tps"] as? NSNumber {
                                Text(String(format: "%.1f tok/s", d.doubleValue))
                                    .font(.system(size: 9, design: .monospaced))
                                    .foregroundStyle(.cyan.opacity(0.9))
                            }
                            if let t = e["ttft_ms"] as? NSNumber {
                                Text(String(format: "ttft %.0fms", t.doubleValue))
                                    .font(.system(size: 9, design: .monospaced))
                                    .foregroundStyle(.white.opacity(0.5))
                            }
                            if let model = e["model"] as? String {
                                Text(model.split(separator: "/").last.map(String.init) ?? model)
                                    .font(.system(size: 8, design: .monospaced))
                                    .foregroundStyle(.white.opacity(0.3))
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Connect

    private var connectCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("CONNECT").font(.system(size: 10, weight: .heavy, design: .monospaced))
                .foregroundStyle(.white.opacity(0.5))
            Text("Point agents at the gateway for traced local inference:")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(.white.opacity(0.4))
            Text("base_url = http://127.0.0.1:11436/\(gatewaySlug)")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.cyan.opacity(0.8))
                .textSelection(.enabled)
            Text("OpenAI · Anthropic Messages — all traced via /traces")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(.white.opacity(0.35))
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.05)))
    }
}
