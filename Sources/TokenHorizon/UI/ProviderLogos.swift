import SwiftUI

struct ProviderLogoView: View {
    let provider: String
    var model: String? = nil
    var size: CGFloat = 20

    var body: some View {
        let p = provider.lowercased()
        let m = (model ?? "").lowercased()

        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(brandBackground(p: p, m: m))

            brandGlyph(p: p, m: m, size: size * 0.62)
        }
        .frame(width: size, height: size)
        .overlay(
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .stroke(Color.white.opacity(0.14), lineWidth: 0.5)
        )
        .shadow(color: Color.black.opacity(0.2), radius: 1, y: 0.5)
    }

    /// Brand background color. Internal for hermetic unit tests.
    func brandBackground(p: String, m: String) -> Color {
        if p.contains("anthropic") || p.contains("claude") || m.contains("claude") {
            return Color(red: 0.85, green: 0.47, blue: 0.34)
        }
        if p.contains("openai") || p.contains("codex") || m.contains("gpt") || m.hasPrefix("o1") || m.hasPrefix("o3") {
            return Color(red: 0.06, green: 0.64, blue: 0.50)
        }
        if p.contains("google") || p.contains("gemini") || m.contains("gemini") || m.contains("gemma") {
            return Color(red: 0.15, green: 0.40, blue: 0.94)
        }
        if p.contains("deepseek") || m.contains("deepseek") {
            return Color(red: 0.08, green: 0.52, blue: 0.92)
        }
        if p.contains("kimi") || p.contains("moonshot") || m.contains("kimi") {
            return Color(red: 0.48, green: 0.28, blue: 0.88)
        }
        if p.contains("glm") || p.contains("zai") || p.contains("zhipu") || m.contains("glm") {
            return Color(red: 0.12, green: 0.44, blue: 0.95)
        }
        if p.contains("minimax") || m.contains("minimax") {
            return Color(red: 0.95, green: 0.30, blue: 0.25)
        }
        if p.contains("alibaba") || p.contains("qwen") || p.contains("bailian") || m.contains("qwen") {
            return Color(red: 1.0, green: 0.42, blue: 0.0)
        }
        if p.contains("xai") || p.contains("grok") || m.contains("grok") {
            return Color(red: 0.14, green: 0.14, blue: 0.16)
        }
        if p.contains("ollama") {
            return Color(red: 0.18, green: 0.18, blue: 0.22)
        }
        if p.contains("mistral") || m.contains("codestral") || m.contains("mistral") {
            return Color(red: 0.95, green: 0.40, blue: 0.05)
        }
        if p.contains("meta") || m.contains("llama") {
            return Color(red: 0.0, green: 0.51, blue: 0.98)
        }
        if p.contains("agy") || p.contains("antigravity") {
            return Color(red: 0.38, green: 0.18, blue: 0.95)
        }
        if p.contains("upstage") || m.contains("solar") {
            return Color(red: 0.42, green: 0.32, blue: 0.95)
        }
        if p.contains("opencode") || p.contains("muse") || m.contains("muse") || m.contains("x-preview") {
            return Color(red: 0.06, green: 0.65, blue: 0.42)
        }
        return DashboardTabs.toolColor(p).opacity(0.85)
    }

    @ViewBuilder
    private func brandGlyph(p: String, m: String, size: CGFloat) -> some View {
        if p.contains("anthropic") || p.contains("claude") || m.contains("claude") {
            // Anthropic Asterisk
            AnthropicAsteriskShape()
                .fill(Color.white)
                .frame(width: size, height: size)
        } else if p.contains("openai") || p.contains("codex") || m.contains("gpt") || m.hasPrefix("o1") || m.hasPrefix("o3") {
            // OpenAI Flower Swirl
            OpenAISwirlShape()
                .stroke(Color.white, style: StrokeStyle(lineWidth: size * 0.14, lineCap: .round))
                .frame(width: size, height: size)
        } else if p.contains("google") || p.contains("gemini") || m.contains("gemini") || m.contains("gemma") {
            // Google Gemini 4-point Sparkle
            GeminiSparkleShape()
                .fill(Color.white)
                .frame(width: size, height: size)
        } else if p.contains("agy") || p.contains("antigravity") {
            // Antigravity Delta
            AntigravityDeltaShape()
                .fill(Color.white)
                .frame(width: size, height: size)
        } else if p.contains("deepseek") || m.contains("deepseek") {
            // DeepSeek Whale Fin
            DeepSeekFinShape()
                .fill(Color.white)
                .frame(width: size, height: size)
        } else if p.contains("kimi") || p.contains("moonshot") || m.contains("kimi") {
            // Moonshot Kimi K
            Text("K")
                .font(.system(size: size * 0.9, weight: .heavy, design: .rounded))
                .foregroundStyle(Color.white)
        } else if p.contains("glm") || p.contains("zai") || p.contains("zhipu") || m.contains("glm") {
            // GLM Prism
            GLMPrismShape()
                .fill(Color.white)
                .frame(width: size, height: size)
        } else if p.contains("minimax") || m.contains("minimax") {
            // MiniMax M
            Text("M")
                .font(.system(size: size * 0.9, weight: .heavy, design: .rounded))
                .foregroundStyle(Color.white)
        } else if p.contains("alibaba") || p.contains("qwen") || p.contains("bailian") || m.contains("qwen") {
            // Qwen Orbit
            QwenOrbitShape()
                .stroke(Color.white, style: StrokeStyle(lineWidth: size * 0.14, lineCap: .round))
                .frame(width: size, height: size)
        } else if p.contains("upstage") || m.contains("solar") {
            // Upstage Solar Sun
            Image(systemName: "sun.max.fill")
                .font(.system(size: size * 0.85))
                .foregroundStyle(Color.white)
        } else if p.contains("xai") || p.contains("grok") || m.contains("grok") {
            // Grok X
            Text("𝕏")
                .font(.system(size: size * 0.9, weight: .heavy, design: .default))
                .foregroundStyle(Color.white)
        } else if p.contains("ollama") {
            // Ollama Llama Silhouette
            OllamaLlamaShape()
                .fill(Color(red: 0.25, green: 0.90, blue: 0.70))
                .frame(width: size, height: size)
        } else if p.contains("mistral") || m.contains("codestral") || m.contains("mistral") {
            // Mistral Staircase
            MistralStepsShape()
                .fill(Color.white)
                .frame(width: size, height: size)
        } else if p.contains("meta") || m.contains("llama") {
            // Meta Infinity
            Text("∞")
                .font(.system(size: size * 1.1, weight: .bold, design: .default))
                .foregroundStyle(Color.white)
        } else if p.contains("opencode") || p.contains("muse") || m.contains("muse") || m.contains("x-preview") {
            // OpenCode Terminal Prompt
            Text(">_")
                .font(.system(size: size * 0.68, weight: .heavy, design: .monospaced))
                .foregroundStyle(Color.white)
        } else {
            let letters = String(m.prefix(2)).uppercased()
            Text(letters.isEmpty ? String(p.prefix(2)).uppercased() : letters)
                .font(.system(size: size * 0.55, weight: .heavy, design: .monospaced))
                .foregroundStyle(Color.white)
        }
    }
}

// MARK: - Custom Vector Logo Shapes

struct AntigravityDeltaShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let w = rect.width
        let h = rect.height
        // Floating upward delta triangle
        path.move(to: CGPoint(x: rect.midX, y: rect.minY + h * 0.12))
        path.addLine(to: CGPoint(x: rect.maxX - w * 0.12, y: rect.maxY - h * 0.15))
        path.addLine(to: CGPoint(x: rect.minX + w * 0.12, y: rect.maxY - h * 0.15))
        path.closeSubpath()
        return path
    }
}

struct AnthropicAsteriskShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let r = min(rect.width, rect.height) / 2
        let spokes = 8
        for i in 0..<spokes {
            let angle = Double(i) * (.pi * 2.0 / Double(spokes))
            let outer = CGPoint(x: center.x + CGFloat(cos(angle)) * r, y: center.y + CGFloat(sin(angle)) * r)
            path.move(to: center)
            path.addLine(to: outer)
        }
        return path.strokedPath(StrokeStyle(lineWidth: rect.width * 0.16, lineCap: .round))
    }
}

struct OpenAISwirlShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let r = min(rect.width, rect.height) * 0.42
        for i in 0..<6 {
            let angle = Double(i) * (.pi / 3.0)
            let p1 = CGPoint(x: center.x + CGFloat(cos(angle)) * (r * 0.4),
                             y: center.y + CGFloat(sin(angle)) * (r * 0.4))
            let p2 = CGPoint(x: center.x + CGFloat(cos(angle + 0.8)) * r,
                             y: center.y + CGFloat(sin(angle + 0.8)) * r)
            path.move(to: p1)
            path.addQuadCurve(to: p2, control: CGPoint(x: center.x + CGFloat(cos(angle + 0.4)) * (r * 1.1),
                                                       y: center.y + CGFloat(sin(angle + 0.4)) * (r * 1.1)))
        }
        return path
    }
}

struct GeminiSparkleShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let w = rect.width / 2
        let h = rect.height / 2
        let pinch: CGFloat = 0.22

        path.move(to: CGPoint(x: c.x, y: c.y - h))
        path.addQuadCurve(to: CGPoint(x: c.x + w, y: c.y), control: CGPoint(x: c.x + w * pinch, y: c.y - h * pinch))
        path.addQuadCurve(to: CGPoint(x: c.x, y: c.y + h), control: CGPoint(x: c.x + w * pinch, y: c.y + h * pinch))
        path.addQuadCurve(to: CGPoint(x: c.x - w, y: c.y), control: CGPoint(x: c.x - w * pinch, y: c.y + h * pinch))
        path.addQuadCurve(to: CGPoint(x: c.x, y: c.y - h), control: CGPoint(x: c.x - w * pinch, y: c.y - h * pinch))
        path.closeSubpath()
        return path
    }
}

struct DeepSeekFinShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let w = rect.width
        let h = rect.height
        path.move(to: CGPoint(x: rect.minX + w * 0.15, y: rect.maxY - h * 0.15))
        path.addCurve(to: CGPoint(x: rect.minX + w * 0.85, y: rect.minY + h * 0.25),
                      control1: CGPoint(x: rect.minX + w * 0.3, y: rect.minY + h * 0.8),
                      control2: CGPoint(x: rect.minX + w * 0.6, y: rect.minY + h * 0.3))
        path.addQuadCurve(to: CGPoint(x: rect.minX + w * 0.55, y: rect.maxY - h * 0.15),
                          control: CGPoint(x: rect.minX + w * 0.8, y: rect.maxY - h * 0.3))
        path.closeSubpath()
        return path
    }
}

struct GLMPrismShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let w = rect.width * 0.45
        let h = rect.height * 0.45
        path.move(to: CGPoint(x: c.x, y: c.y - h))
        path.addLine(to: CGPoint(x: c.x + w, y: c.y))
        path.addLine(to: CGPoint(x: c.x, y: c.y + h))
        path.addLine(to: CGPoint(x: c.x - w, y: c.y))
        path.closeSubpath()
        return path
    }
}

struct QwenOrbitShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let w = rect.width
        let h = rect.height
        path.addEllipse(in: CGRect(x: rect.minX + w * 0.1, y: rect.minY + h * 0.1, width: w * 0.8, height: h * 0.8))
        path.move(to: CGPoint(x: rect.minX + w * 0.6, y: rect.minY + h * 0.6))
        path.addLine(to: CGPoint(x: rect.minX + w * 0.9, y: rect.minY + h * 0.9))
        return path
    }
}

struct OllamaLlamaShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let w = rect.width
        let h = rect.height
        // Llama head profile & ears
        path.move(to: CGPoint(x: rect.minX + w * 0.25, y: rect.maxY - h * 0.15))
        path.addLine(to: CGPoint(x: rect.minX + w * 0.25, y: rect.minY + h * 0.35))
        path.addLine(to: CGPoint(x: rect.minX + w * 0.38, y: rect.minY + h * 0.1)) // Left ear
        path.addLine(to: CGPoint(x: rect.minX + w * 0.48, y: rect.minY + h * 0.35))
        path.addLine(to: CGPoint(x: rect.minX + w * 0.60, y: rect.minY + h * 0.1)) // Right ear
        path.addLine(to: CGPoint(x: rect.minX + w * 0.70, y: rect.minY + h * 0.35))
        path.addLine(to: CGPoint(x: rect.minX + w * 0.85, y: rect.minY + h * 0.55)) // Snout
        path.addLine(to: CGPoint(x: rect.minX + w * 0.85, y: rect.minY + h * 0.75))
        path.addLine(to: CGPoint(x: rect.minX + w * 0.65, y: rect.minY + h * 0.85))
        path.addLine(to: CGPoint(x: rect.minX + w * 0.65, y: rect.maxY - h * 0.15))
        path.closeSubpath()
        return path
    }
}

struct MistralStepsShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let w = rect.width
        let h = rect.height
        let barW = w * 0.18
        // 4 stepping blocks
        let heights: [CGFloat] = [0.35, 0.65, 0.95, 0.50]
        for (i, bh) in heights.enumerated() {
            let x = rect.minX + CGFloat(i) * (w * 0.24)
            let y = rect.maxY - h * bh
            path.addRoundedRect(in: CGRect(x: x, y: y, width: barW, height: h * bh), cornerSize: CGSize(width: 1, height: 1))
        }
        return path
    }
}
