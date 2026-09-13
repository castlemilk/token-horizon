import Foundation

/// Gemini `usageMetadata` → TokenBreakdown — ONE parser shared by the
/// GeminiMeter (wire) and UsageEngine (file backfill). Both snake_case and
/// camelCase spellings occur across channels. `promptTokenCount` INCLUDES
/// cached tokens (see GeminiMeter.contextOccupancy). Falls back to the bare
/// total (attributed as input) when components are absent.
public enum GeminiUsage {
    public static func breakdown(from meta: [String: Any]) -> TokenBreakdown {
        func int(_ key: String) -> Int { (meta[key] as? NSNumber)?.intValue ?? 0 }
        // snake_case vs camelCase are alternate spellings — max, never sum.
        let grossInput = max(int("prompt_token_count"), int("promptTokenCount"))
        let output = max(int("candidates_token_count"), int("candidatesTokenCount"))
        let reasoning = max(int("thoughts_token_count"), int("thoughtsTokenCount"))
        let cacheRead = max(int("cached_content_token_count"), int("cachedContentTokenCount"))
        // promptTokenCount INCLUDES cached tokens (subset) — store NET input
        // so total == provider truth. Already-net payloads kept as-is.
        // thoughts are billed separately, kept.
        var b = TokenBreakdown(
            input: cacheRead <= grossInput ? grossInput - cacheRead : grossInput,
            output: output,
            reasoning: reasoning,
            cacheRead: cacheRead)
        if b.total == 0 {
            let total = max(int("total_token_count"), int("totalTokenCount"))
            if total > 0 { b.input += total }
        }
        return b
    }
}
