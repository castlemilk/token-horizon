import SwiftUI

/// ENGINE tab — local inference platform: engine status, model catalog with
/// hardware-fit badges, serve/stop controls, and live decode metrics.
/// All state comes from EngineSupervisor (which probes the engine itself);
/// this view never invents status.
struct EngineTabView: View {
    @ObservedObject private var engine = EngineSupervisor.shared
    @State private var overrides = false
    @State private var memDraft = ""
    @State private var ctxDraft = ""

    private let machine = HardwareProfile.probe()

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            statusCard
            catalogCard
            connectCard
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
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
                if case .serving = engine.state {
                    Button("STOP") { engine.stop() }
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundStyle(.red.opacity(0.9))
                        .buttonStyle(.plain)
                }
            }

            if case .failed(let reason) = engine.state {
                Text(reason)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.red.opacity(0.8))
                    .lineLimit(3)
            }

            if !engine.engineAvailable {
                Text("splash not installed — run: brew install incoai/tap/splash")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.yellow.opacity(0.85))
            }

            if let blocker = HardwareProfile.eligibilityBlocker(machine) {
                Label(blocker, systemImage: "exclamationmark.triangle")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.yellow)
            }

            // Live engine stats when serving
            if let s = engine.status {
                HStack(spacing: 14) {
                    if let m = s["metrics"] as? [String: Any],
                       let tps = m["decode_tokens_per_second"] as? NSNumber {
                        metric("DECODE", String(format: "%.0f tok/s", tps.doubleValue))
                    }
                    if let mem = s["memory_actual"] as? [String: Any],
                       let cur = mem["current_bytes"] as? NSNumber {
                        metric("GPU MEM", String(format: "%.1f GiB", cur.doubleValue / 1_073_741_824))
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
        switch engine.state {
        case .serving: return .green
        case .starting: return .blue
        case .failed: return .red
        case .stopped: return .gray.opacity(0.5)
        }
    }

    private var statusTitle: String {
        switch engine.state {
        case .serving(let model, _, let attached):
            return "SERVING \(model.split(separator: "/").last.map(String.init) ?? model)\(attached ? " (attached)" : "")"
        case .starting(let model):
            return "STARTING \(model.split(separator: "/").last.map(String.init) ?? model)…"
        case .failed:
            return "ENGINE FAILED"
        case .stopped:
            return "ENGINE STOPPED"
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

    // MARK: - Model catalog

    private var catalogCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("MODELS").font(.system(size: 10, weight: .heavy, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.5))
                Spacer()
                Button(overrides ? "auto-tuned" : "customize") { overrides.toggle() }
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.4))
                    .buttonStyle(.plain)
            }
            if overrides {
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
            ForEach(HardwareProfile.catalog, id: \.id) { m in
                modelRow(m)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.05)))
    }

    private func modelRow(_ m: HardwareProfile.EngineModel) -> some View {
        let fit = HardwareProfile.fit(m, on: machine)
        let installed = EngineSupervisor.installedModelIDs().contains(m.id)
        let ceil = HardwareProfile.recommendedCeilings(m, on: machine)
        let serving = engine.state.isServing
        return HStack(spacing: 10) {
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
            Button("SERVE") {
                let mem = overrides ? Int(memDraft) : ceil.maxMemoryGB
                let ctx = overrides ? Int(ctxDraft) : ceil.maxContextK
                engine.serve(model: m.id, maxMemoryGB: mem, maxContextK: ctx)
            }
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .foregroundStyle(.black)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(Capsule().fill(serving || fit == .unsupported
                                       ? Color.white.opacity(0.2) : Color.white))
            .buttonStyle(.plain)
            .disabled(serving || fit == .unsupported || !engine.engineAvailable)
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

    // MARK: - Connect

    private var connectCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("CONNECT").font(.system(size: 10, weight: .heavy, design: .monospaced))
                .foregroundStyle(.white.opacity(0.5))
            Text("Point agents at the gateway for traced local inference:")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(.white.opacity(0.4))
            Text("base_url = http://127.0.0.1:11436/th-splash")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.cyan.opacity(0.8))
                .textSelection(.enabled)
            Text("OpenAI · Responses · Anthropic Messages — all traced via /traces")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(.white.opacity(0.35))
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.05)))
    }
}
