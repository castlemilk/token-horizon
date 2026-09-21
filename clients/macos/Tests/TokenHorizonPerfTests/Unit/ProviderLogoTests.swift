import XCTest
@testable import TokenHorizon
import SwiftUI

/// Tests for provider brand colors and tool colors (status readability
/// hinges on these mappings staying stable).
final class ProviderLogoTests: XCTestCase {

    func testBrandBackground() {
        let view = ProviderLogoView(provider: "x")
        struct Case { let p: String; let m: String; let want: Color }
        let cases: [Case] = [
            Case(p: "anthropic", m: "", want: Color(red: 0.85, green: 0.47, blue: 0.34)),
            Case(p: "openai", m: "", want: Color(red: 0.06, green: 0.64, blue: 0.50)),
            Case(p: "google", m: "", want: Color(red: 0.15, green: 0.40, blue: 0.94)),
            Case(p: "deepseek", m: "", want: Color(red: 0.08, green: 0.52, blue: 0.92)),
            Case(p: "kimi", m: "", want: Color(red: 0.48, green: 0.28, blue: 0.88)),
            Case(p: "glm", m: "", want: Color(red: 0.12, green: 0.44, blue: 0.95)),
            Case(p: "minimax", m: "", want: Color(red: 0.95, green: 0.30, blue: 0.25)),
            Case(p: "alibaba", m: "", want: Color(red: 1.0, green: 0.42, blue: 0.0)),
            Case(p: "xai", m: "", want: Color(red: 0.14, green: 0.14, blue: 0.16)),
            Case(p: "ollama", m: "", want: Color(red: 0.18, green: 0.18, blue: 0.22)),
            Case(p: "mistral", m: "", want: Color(red: 0.95, green: 0.40, blue: 0.05)),
            Case(p: "meta", m: "", want: Color(red: 0.0, green: 0.51, blue: 0.98)),
            // Model-name fallback when the provider is unknown.
            Case(p: "zzz", m: "claude-x", want: Color(red: 0.85, green: 0.47, blue: 0.34)),
            // Unknown falls through to the tool color at reduced opacity.
            Case(p: "zzz", m: "", want: Color.gray.opacity(0.85)),
        ]
        for (i, tc) in cases.enumerated() {
            XCTAssertEqual(view.brandBackground(p: tc.p, m: tc.m), tc.want, "case \(i)")
        }
    }

    func testToolColor() {
        struct Case { let tool: String; let want: Color }
        let cases: [Case] = [
            Case(tool: "opencode", want: .green),
            Case(tool: "claude", want: .orange),
            Case(tool: "codex", want: .cyan),
            Case(tool: "kimi", want: .purple),
            Case(tool: "glm", want: .yellow),
            Case(tool: "qwen", want: .blue),
            Case(tool: "grok", want: .pink),
            Case(tool: "gemini", want: Color(red: 0.26, green: 0.52, blue: 0.96)),
            Case(tool: "agy", want: Color(red: 0.65, green: 0.45, blue: 0.95)),
            Case(tool: "deepseek", want: .teal),
            Case(tool: "ollama", want: Color(red: 0.18, green: 0.82, blue: 0.72)),
            Case(tool: "mystery", want: .gray),
        ]
        for (i, tc) in cases.enumerated() {
            XCTAssertEqual(DashboardTabs.toolColor(tc.tool), tc.want, "case \(i)")
        }
    }
}
