import SwiftUI

/// ENGINE tab — local inference platform. Two supervised backends:
/// Splash (incoai's specialised engine, :8000) and TH Engine (our
/// Rust/candle sidecar, :8001). All state comes from EngineManager →
/// per-backend supervisors (which probe the engines themselves); this
/// view never invents status.
struct EngineTabView: View {
    @ObservedObject private var mgr = EngineManager.shared
    @State private var backend = "splash"
    @State private var overrides = false
    @State private var memDraft = ""
    @State private var ctxDraft = ""

    private let machine = HardwareProfile.probe()

    private var sup: BackendSupervisor {
        mgr.supervisor(for: backend) ?? mgr.splash
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            backendPicker
            statusCard
            if backend == "splash" { splashCatalogCard } else { thengineCatalogCard }
            benchCard
            connectCard
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    // MARK: - Backend picker

    private var backendPicker: some View {
        HStack(spacing: 4) {
            ForEach(["splash", "thengine"], id: \.self) { b in
                Button(b == "splash" ? "SPLASH" : "TH ENGINE") { backend = b }
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(backend == b ? .black : .white.opacity(0.5))
                    .padding(.horizontal, 12).padding(.vertical, 5)
                    .background(Capsule().fill(backend == b ? .white : .white.opacity(0.08)))
                    .buttonStyle(.plain)
            }
            Spacer()
            // per-backend availability dot
            Circle()
                .fill(mgr.splash.state.isServing ? .green : .white.opacity(0.15))
                .frame(width: 6, height: 6)
            Text("splash")
                .font(.system(size: 8, design: .monospaced))
                .foregroundStyle(.white.opacity(0.35))
            Circle()
                .fill(mgr.thengine.state.isServing ? .green : .white.opacity(0.15))
                .frame(width: 6, height: 6)
            Text("thengine")
                .font(.system(size: 8, design: .monospaced))
                .foregroundStyle(.white.opacity(0.35))
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
                if case .serving = sup.state {
                    Button("STOP") { sup.stop() }
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundStyle(.red.opacity(0.9))
                        .buttonStyle(.plain)
                }
            }

            if case .failed(let reason) = sup.state {
                Text(reason)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.red.opacity(0.8))
                    .lineLimit(3)
            }

            if !sup.engineAvailable {
                Text(backend == "splash"
                     ? "splash not installed — run: brew install incoai/tap/splash"
                     : "th-engine not built — run: cargo build --release -p th-engine (engine/)")
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

    private var statusColor: Color {
        switch sup.state {
        case .serving: return .green
        case .starting: return .blue
        case .failed: return .red
        case .stopped: return .gray.opacity(0.5)
        }
    }

    private var statusTitle: String {
        let name = backend == "splash" ? "SPLASH" : "TH ENGINE"
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

    // MARK: - Splash catalog

    private var splashCatalogCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            catalogHeader
            ForEach(HardwareProfile.catalog, id: \.id) { m in
                splashModelRow(m)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.05)))
    }

    private var catalogHeader: some View {
        HStack {
            Text("MODELS").font(.system(size: 10, weight: .heavy, design: .monospaced))
                .foregroundStyle(.white.opacity(0.5))
            Spacer()
            Button(overrides ? "auto-tuned" : "customize") { overrides.toggle() }
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(.white.opacity(0.4))
                .buttonStyle(.plain)
        }
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

    private func splashModelRow(_ m: HardwareProfile.EngineModel) -> some View {
        let fit = HardwareProfile.fit(m, on: machine)
        let installed = splashInstalledModelIDs().contains(m.id)
        let ceil = HardwareProfile.recommendedCeilings(m, on: machine)
        let serving = sup.state.isServing || sup.state.isBusy
        return VStack(alignment: .leading, spacing: 4) {
            if overrides { overrideFields }
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(m.displayName)
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.9))
                    Text("\(String(format: "%.1f", m.packageGB)) GB package · \(m.kind)")
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.4))
                }
                Spacer()
                Text(installed ? "installed" : "")
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(.green.opacity(0.7))
                Text(fit.badge)
                    .font(.system(size: 8, weight: .bold, design: .monospaced))
                    .foregroundStyle(fitColor(fit))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Capsule().fill(fitColor(fit).opacity(0.15)))
                serveButton(enabled: !serving && fit != .unsupported && sup.engineAvailable) {
                    let mem = overrides ? Int(memDraft) : ceil.maxMemoryGB
                    let ctx = overrides ? Int(ctxDraft) : ceil.maxContextK
                    sup.serve(model: m.id, maxMemoryGB: mem, maxContextK: ctx)
                }
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

    // MARK: - TH Engine catalog

    private var thengineCatalogCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            catalogHeader
            if overrides { overrideFields }
            ForEach(THEngineModel.catalog, id: \.id) { m in
                thengineModelRow(m)
            }
            Text("TH Engine runs any GGUF/safetensors HF repo — serve via API with an explicit model spec.")
                .font(.system(size: 8, design: .monospaced))
                .foregroundStyle(.white.opacity(0.3))
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.05)))
    }

    private func thengineModelRow(_ m: THEngineModel) -> some View {
        let installed = THEngineModel.installed(m)
        let serving = sup.state.isServing || sup.state.isBusy
        // Rough fit: GGUF resident ≈ package size; want headroom over it.
        let fits = machine.physicalMemoryGB > m.approxGB + 8
        return HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(m.displayName)
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.9))
                Text("\(String(format: "%.1f", m.approxGB)) GB · \(m.kind)")
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.4))
            }
            Spacer()
            Text(installed ? "cached" : "")
                .font(.system(size: 8, design: .monospaced))
                .foregroundStyle(.green.opacity(0.7))
            if !fits {
                Text("tight")
                    .font(.system(size: 8, weight: .bold, design: .monospaced))
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Capsule().fill(Color.orange.opacity(0.15)))
            }
            serveButton(enabled: !serving && sup.engineAvailable) {
                let ctx = overrides ? Int(ctxDraft) : nil
                sup.serve(model: m.modelSpec, tokenizer: m.tokenizerRepo,
                          maxMemoryGB: nil, maxContextK: ctx)
            }
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
            Text("base_url = http://127.0.0.1:11436/\(backend == "splash" ? "th-splash" : "th-engine")")
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
