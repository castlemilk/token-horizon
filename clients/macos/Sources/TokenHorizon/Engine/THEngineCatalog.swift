import Foundation

/// TH-engine model catalog — the models our Rust/candle sidecar can run.
///
/// Unlike Splash's fixed packages these are ordinary HF repos: GGUF quants
/// run on Metal via candle's quantized kernels; safetensors dirs run dense
/// (CPU F32 — a correctness path, not the fast one). `tokenizer` points at
/// the sibling base repo when a GGUF repo ships no tokenizer.json.
struct THEngineModel {
    let id: String              // HF repo id ("org/repo[:file]") or local path
    let displayName: String
    let file: String?           // explicit file inside the repo (a .gguf)
    let tokenizerRepo: String?  // passed as --tokenizer
    let approxGB: Double        // download size
    let kind: String            // "gguf" | "safetensors"

    /// Model spec handed to `th-engine serve --model` — `repo:file` when a
    /// file is pinned, else the bare repo/path.
    var modelSpec: String {
        if let f = file { return "\(id):\(f)" }
        return id
    }

    /// Curated list — entries we've verified load through candle 0.11.
    /// Fit is checked live against HardwareProfile at serve time.
    static let catalog: [THEngineModel] = [
        THEngineModel(id: "Qwen/Qwen3-32B-GGUF",
                      displayName: "Qwen3 32B · Q4_K_M",
                      file: "Qwen3-32B-Q4_K_M.gguf",
                      tokenizerRepo: "Qwen/Qwen3-32B",
                      approxGB: 19.9, kind: "gguf"),
        THEngineModel(id: "Qwen/Qwen3-8B-GGUF",
                      displayName: "Qwen3 8B · Q4_K_M",
                      file: "Qwen3-8B-Q4_K_M.gguf",
                      tokenizerRepo: "Qwen/Qwen3-8B",
                      approxGB: 5.0, kind: "gguf"),
        THEngineModel(id: "Qwen/Qwen3-0.6B-GGUF",
                      displayName: "Qwen3 0.6B · Q8_0 (smoke)",
                      file: "Qwen3-0.6B-Q8_0.gguf",
                      tokenizerRepo: "Qwen/Qwen3-0.6B",
                      approxGB: 0.7, kind: "gguf"),
    ]

    /// Whether the repo's weights are already in the HF cache — checked by
    /// the presence of the model dir (contents verified lazily by hf-hub).
    static func installed(_ m: THEngineModel) -> Bool {
        let dir = "models--" + m.id.replacingOccurrences(of: "/", with: "--")
        let root = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".cache/huggingface/hub/\(dir)/snapshots")
        guard let snaps = try? FileManager.default.contentsOfDirectory(
            at: root, includingPropertiesForKeys: nil) else { return false }
        // A snapshot is usable if it has the pinned file (or any weights).
        for snap in snaps {
            if let f = m.file,
               FileManager.default.fileExists(atPath: snap.appendingPathComponent(f).path) {
                return true
            }
            if m.file == nil,
               (try? FileManager.default.contentsOfDirectory(
                    at: snap, includingPropertiesForKeys: nil))?
                    .contains(where: { $0.lastPathComponent.hasSuffix(".safetensors") }) == true {
                return true
            }
        }
        return false
    }

    static func catalogPayload() -> [[String: Any]] {
        catalog.map { m in
            [
                "id": m.modelSpec, "name": m.displayName, "kind": m.kind,
                "package_gb": m.approxGB,
                "tokenizer_repo": m.tokenizerRepo ?? NSNull(),
                "installed": installed(m),
                "backend": "thengine",
            ]
        }
    }
}
