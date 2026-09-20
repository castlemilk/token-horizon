import SwiftUI

struct LocalModelMetadataView: View {
    let metadata: LocalModelMetadata

    private struct Fact: Identifiable {
        let id: String
        let label: String
        let value: String
    }

    private let factDefinitions: [(key: String, label: String)] = [
        ("size", "SIZE"),
        ("size_bytes", "SIZE BYTES"),
        ("parameter_size", "PARAMETERS"),
        ("parameter_count", "PARAMETER COUNT"),
        ("num_parameters", "PARAMETER COUNT"),
        ("quantization_level", "QUANTIZATION"),
        ("quantization", "QUANTIZATION"),
        ("bits", "QUANTIZATION"),
        ("weight_bits", "QUANTIZATION"),
        ("format", "FORMAT"),
        ("context_length", "CONTEXT"),
        ("architecture", "ARCHITECTURE"),
        ("architectures", "ARCHITECTURE"),
        ("file_count", "FILES"),
        ("digest", "DIGEST"),
        ("modified_at", "MODIFIED")
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(metadata.backend.uppercased())
                    .font(.system(size: 7, weight: .heavy, design: .monospaced))
                    .foregroundStyle(.teal)
                Text(metadata.model)
                    .font(.system(size: 8.5, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.7))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
            }

            if !quickFacts.isEmpty {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 105), alignment: .leading)], alignment: .leading, spacing: 6) {
                    ForEach(quickFacts) { fact in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(fact.label)
                                .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                                .foregroundStyle(.secondary)
                            Text(fact.value)
                                .font(.system(size: 8.5, weight: .semibold, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.85))
                                .lineLimit(2)
                                .truncationMode(.middle)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(5)
                        .background(RoundedRectangle(cornerRadius: 4).fill(Color.white.opacity(0.04)))
                    }
                }
            }

            if let error = metadata.error {
                Text(error)
                    .font(.system(size: 8.5, design: .monospaced))
                    .foregroundStyle(.orange.opacity(0.9))
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }

            ForEach(metadata.sections.keys.sorted(), id: \.self) { key in
                if let value = metadata.sections[key] {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(key.uppercased())
                            .font(.system(size: 7, weight: .heavy, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .kerning(0.7)
                        LocalMetadataValueView(value: value)
                    }
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 5).fill(Color.white.opacity(0.025)))
                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.white.opacity(0.06), lineWidth: 1))
                }
            }
        }
    }

    private var quickFacts: [Fact] {
        var seen = Set<String>()
        var facts: [Fact] = []
        for definition in factDefinitions {
            guard let result = firstScalar(for: definition.key), seen.insert(definition.label).inserted else { continue }
            facts.append(Fact(id: definition.label, label: definition.label, value: factText(key: result.key, value: result.value)))
        }
        return facts
    }

    private func firstScalar(for key: String) -> (key: String, value: String)? {
        let orderedSections = metadata.sections.keys.sorted { lhs, rhs in
            func rank(_ name: String) -> Int {
                let lower = name.lowercased()
                if lower == "overview" { return 0 }
                if lower.hasPrefix("installed") { return 1 }
                if lower.hasPrefix("configuration") { return 2 }
                if lower == "files" { return 3 }
                return 4
            }
            let lRank = rank(lhs)
            let rRank = rank(rhs)
            return lRank == rRank ? lhs < rhs : lRank < rRank
        }
        for section in orderedSections {
            if let value = metadata.sections[section],
               let result = value.firstScalar(matching: [key]) {
                return result
            }
        }
        return nil
    }

    private func factText(key: String, value: String) -> String {
        let lower = key.lowercased()
        guard lower == "size" || lower.hasSuffix("_bytes") || lower == "size_vram" else { return value }
        guard let bytes = UInt64(value) else { return value }
        let formatted = ByteCountFormatter.string(fromByteCount: Int64(min(bytes, UInt64(Int64.max))), countStyle: .file)
        return "\(formatted) (\(value) bytes)"
    }
}

struct LocalMetadataValueView: View {
    let label: String?
    let value: LocalMetadataValue
    let depth: Int

    init(label: String? = nil, value: LocalMetadataValue, depth: Int = 0) {
        self.label = label
        self.value = value
        self.depth = depth
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if let label {
                Text(label)
                    .font(.system(size: 7.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            switch value {
            case .object(let values):
                if values.isEmpty {
                    scalarText("{}")
                } else {
                    ForEach(values.keys.sorted(), id: \.self) { key in
                        if let child = values[key] {
                            LocalMetadataValueView(label: key, value: child, depth: depth + 1)
                        }
                    }
                }
            case .array(let values):
                if values.isEmpty {
                    scalarText("[]")
                } else {
                    ForEach(Array(values.enumerated()), id: \.offset) { index, child in
                        LocalMetadataValueView(label: "[\(index)]", value: child, depth: depth + 1)
                    }
                }
            case .string(let text):
                scalarText(text)
            case .number(let number):
                scalarText(number)
            case .bool(let bool):
                scalarText(bool ? "true" : "false")
            case .null:
                scalarText("null")
            }
        }
        .padding(.leading, label == nil ? 0 : min(CGFloat(depth) * 5, 30))
    }

    private func scalarText(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 8, design: .monospaced))
            .foregroundStyle(.white.opacity(0.75))
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }
}

struct MLXRunnerDetailView: View {
    let process: MLXProcess
    @Environment(\.dismiss) private var dismiss
    @State private var metadata: LocalModelMetadata?
    @State private var loadingMetadata = true

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    ProviderLogoView(provider: "mlx", model: process.model, size: 40)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(process.model ?? process.name)
                            .font(.system(size: 15, weight: .bold, design: .monospaced))
                            .foregroundStyle(.white)
                            .lineLimit(2)
                            .truncationMode(.middle)
                        Text("MLX RUNNER · PID \(process.pid)")
                            .font(.system(size: 8, weight: .heavy, design: .monospaced))
                            .foregroundStyle(.teal)
                    }
                    Spacer()
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text("LIVE PROCESS")
                        .font(.system(size: 8, weight: .heavy, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .kerning(1)
                    runnerDetailRow("cpu", String(format: "%.2f%%", process.cpu))
                    runnerDetailRow("memory", formatMemory(process.memoryMB))
                    runnerDetailRow("disk", String(format: "read %.2fM/s · write %.2fM/s", process.diskReadMBps, process.diskWriteMBps))
                    runnerDetailRow("decode tok/s", process.tokPerSec.map { String(format: "%.2f", $0) } ?? "unavailable")
                    runnerDetailRow("prefill tok/s", process.prefillTokPerSec.map { String(format: "%.2f", $0) } ?? "unavailable")
                    if let ttft = process.ttftSeconds {
                        runnerDetailRow("ttft", String(format: "%.2f s", ttft))
                    }
                    runnerDetailRow("parent", "\(process.ppid)")
                    runnerDetailRow("started", process.startTime.formatted(date: .abbreviated, time: .standard))
                    runnerDetailRow("command", process.command, selectable: true)
                }
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))

                Divider().overlay(Color.white.opacity(0.12))
                Text("MODEL CONFIGURATION")
                    .font(.system(size: 8, weight: .heavy, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .kerning(1)
                if let metadata {
                    LocalModelMetadataView(metadata: metadata)
                } else if loadingMetadata {
                    HStack(spacing: 6) {
                        ProgressView().scaleEffect(0.55)
                        Text("Reading model configuration...")
                            .font(.system(size: 8.5, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Text("No model configuration was found for this runner.")
                        .font(.system(size: 8.5, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }
            .padding(16)
        }
        .frame(width: 620, height: 680)
        .background(Color(nsColor: .windowBackgroundColor))
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        .task(id: process.id) { await loadMetadata() }
    }

    private func loadMetadata() async {
        guard let modelName = process.model, !modelName.isEmpty else {
            loadingMetadata = false
            return
        }

        let result: LocalModelMetadata?
        if MLXModelInspector.modelDirectory(for: modelName) != nil {
            result = await Task.detached(priority: .utility) {
                MLXModelInspector.metadata(for: modelName, command: process.command)
            }.value
        } else {
            result = nil
        }
        guard !Task.isCancelled else { return }
        metadata = result
        loadingMetadata = false
    }

    private func runnerDetailRow(_ label: String, _ value: String, selectable: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(label)
                .font(.system(size: 8, design: .monospaced))
                .foregroundStyle(.white.opacity(0.35))
                .frame(width: 54, alignment: .leading)
            Text(value)
                .font(.system(size: 8, design: .monospaced))
                .foregroundStyle(.white.opacity(0.75))
                .fixedSize(horizontal: false, vertical: true)
                .modifier(ConditionalTextSelection(enabled: selectable))
        }
    }

    private func formatMemory(_ megabytes: Double) -> String {
        megabytes >= 1024 ? String(format: "%.2f GB", megabytes / 1024) : String(format: "%.0f MB", megabytes)
    }
}

private struct ConditionalTextSelection: ViewModifier {
    let enabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            content.textSelection(.enabled)
        } else {
            content
        }
    }
}

