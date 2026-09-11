import Foundation
import TokenHorizonCore

/// Core → app model adapters. TokenHorizonCore owns the measurement types;
/// the app keeps its richer view models (shares, projects, accounts).
/// These initializers are the ONLY Core/app boundary — views never import
/// Core types directly.

extension ProviderLimit {
    init(_ core: TokenHorizonCore.ProviderLimit) {
        self.init(provider: core.provider, label: core.label,
                  usedPercent: core.usedPercent,
                  resetsAt: core.resetsAt, detail: core.detail)
    }
}

extension ToolUsage {
    init(_ core: TokenHorizonCore.ToolUsage) {
        self.init(tool: core.tool,
                  tokensToday: core.tokensToday,
                  tokensAllTime: core.tokensAllTime,
                  costToday: core.costToday,
                  costAllTime: core.costAllTime,
                  cacheReadAll: core.cacheReadAll,
                  cacheWriteAll: core.cacheWriteAll,
                  inputTokensToday: core.breakdownToday.input,
                  outputTokensToday: core.breakdownToday.output,
                  inputTokensAllTime: core.breakdownAll.input,
                  outputTokensAllTime: core.breakdownAll.output)
    }
}

extension ModelUsage {
    init(_ core: TokenHorizonCore.ModelUsage) {
        self.init(provider: core.provider, model: core.model,
                  tokensAll: core.tokensAll, tokensToday: core.tokensToday,
                  cost: core.cost, messages: core.messages, free: core.free,
                  cacheReadAll: core.cacheReadAll, estCost: core.estCost,
                  contextK: core.contextK, tokPerSec: core.tokPerSec,
                  promptTokPerSec: core.promptTokPerSec,
                  paramSize: core.paramSize, quant: core.quant,
                  isLocal: core.isLocal, capabilities: core.capabilities)
        inputTokensAll = core.breakdown.input
    }
}

extension SessionSummary {
    init(_ core: TokenHorizonCore.SessionSummary) {
        self.id = core.id
        self.title = core.title
        self.cost = core.cost
        self.tokens = core.tokens
        self.directory = core.directory
        self.created = core.created
    }
}

extension HistoryPoint {
    init(_ core: TokenHorizonCore.HistoryPoint) {
        self.day = core.day
        self.tokens = core.tokens
        self.cost = core.cost
        self.byTool = core.byTool
    }
}

extension UsageSnapshot {
    init(_ core: TokenHorizonCore.UsageSnapshot) {
        self.init()
        tokensToday = core.tokensToday
        tokensAllTime = core.tokensAllTime
        costToday = core.costToday
        costAllTime = core.costAllTime
        perTool = core.perTool.map(ToolUsage.init)
        models = core.models.map(ModelUsage.init)
        limits = core.limits.map(ProviderLimit.init)
        recentSessions = core.recentSessions.map(SessionSummary.init)
        sources = core.sources
        updatedAt = core.updatedAt
        inputTokensToday = core.breakdownToday.input
        outputTokensToday = core.breakdownToday.output
        inputTokensAllTime = core.breakdownAll.input
        outputTokensAllTime = core.breakdownAll.output
    }
}

extension TrendWindow {
    /// App window → Core window (same raw values; Core ticks at 5-min).
    var core: TokenHorizonCore.TrendWindow {
        TokenHorizonCore.TrendWindow(rawValue: rawValue) ?? .month
    }
}

extension ShellEvent {
    init(_ core: TokenHorizonCore.ShellEvent) {
        self.id = core.id
        self.time = core.time
        self.cwd = core.cwd
        self.durationMs = core.durationMs
        self.exit = core.exit
    }
}
