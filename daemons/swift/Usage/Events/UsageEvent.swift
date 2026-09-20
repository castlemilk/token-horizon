import Foundation

/// Where a measurement came from.
public enum SourceKind: String, Codable {
    case external      // cloud vendor (claude, codex, kimi, ...)
    case selfManaged   // local runtime (vllm, sglang, llamacpp, ollama)
    case gateway       // team metering proxy (future tier-3 attestation)
}

/// How much trust a measurement carries (leaderboard verification tiers).
public enum Attestation: String, Codable {
    case selfReported    // read from local logs — honor system
    case measured        // measured live by a local loopback request meter
    case reconciled      // cross-checked against the provider's server-side API
    case gatewayMetered  // measured by a team-controlled gateway
}

/// How the TOOL label on an event was established. Product (claude-code,
/// codex, pi, ...) is orthogonal to vendor — claude code can call kimi.
public enum ProductSource: String, Codable {
    case explicitLabel   // operator pinned the meter port (TH_METERS vendor:port@product)
    case headerSniffed   // inferred from request headers (User-Agent table)
    case fileJoined      // joined from the tool's own session files via request id
}

/// How the cost on an event was established (see CostEngine).
public enum CostSource: String, Codable {
    case reported   // provider/tool-reported cost, joined from files (pi, opencode)
    case computed   // ModelCatalog list pricing × measured tokens
    case planFree   // subscription/plan vendor — zero marginal cost, quota is the ceiling
    case unknown    // model not in catalog; no pricing basis
}

/// Tool attribution (and optionally reported cost) recovered from a tool's
/// own session files, keyed by the PROVIDER request id so it can join a
/// metered event. Files never create usage rows — they only annotate rows
/// the meter measured. Annotations with no matching metered request stay
/// pending forever and count for nothing.
public struct FileAnnotation: Codable {
    public var vendor: String      // canonical upstream vendor (joins usage_event.vendor)
    public var requestID: String   // provider request id (joins request_id / request_id_alt)
    public var product: String?    // the tool ("claude-code", "pi", ...)
    public var cost: Double?       // tool/provider-reported cost, when the file carries it
    public var timestamp: Date
    public var sourceFile: String

    public init(vendor: String, requestID: String, product: String? = nil,
                cost: Double? = nil, timestamp: Date = Date(), sourceFile: String = "") {
        self.vendor = vendor
        self.requestID = requestID
        self.product = product
        self.cost = cost
        self.timestamp = timestamp
        self.sourceFile = sourceFile
    }
}

/// The single unit of token measurement. One per request (or per measured
/// counter-delta interval for runtime sources). Every collector — vendor
/// file-tailer, API poller, Prometheus scraper, gateway — emits these.
/// Append-only and UUID-keyed so per-machine stores merge conflict-free.
public struct UsageEvent: Codable, Identifiable {
    public var id: UUID
    public var timestamp: Date
    /// Stable per-machine identifier (see MachineIdentity).
    public var machineID: String
    /// Human-readable machine name inferred on top of the id (hostname,
    /// user-overridable) — display/UX only; machineID remains the key.
    /// Stored ONCE per machine in the `machine` table (writers set it here
    /// for registration; reads populate it via the machine JOIN).
    public var machineAlias: String?
    public var source: SourceKind
    public var vendor: String
    public var model: String
    public var tokens: TokenBreakdown
    /// Live context-window fill at request time, when the client exposes it.
    public var contextOccupancy: Int?
    /// Model context capacity (from ModelCatalog), when known.
    public var contextLimit: Int?
    public var cost: Double
    /// Measured prompt-processing throughput, when available.
    public var promptTokPerSec: Double?
    /// Measured generation throughput, when available.
    public var generationTokPerSec: Double?
    public var latencyMs: Int?
    /// Client session correlation (claude/codex/opencode session id).
    public var sessionID: String?
    /// Configured thinking/reasoning effort, normalized across vendors:
    /// "off" | "low" | "medium" | "high" | "adaptive" (vendor decides dynamically).
    /// Vendors represent this wildly differently (OpenAI reasoning_effort,
    /// Anthropic thinking.budget_tokens, Gemini thinkingBudget, Ollama think) —
    /// meters normalize here and keep the native form in thinkingRaw.
    public var thinkingLevel: String?
    /// Vendor-native thinking representation (e.g. "budget_tokens:16000").
    public var thinkingRaw: String?
    /// Client product the request came from ("claude-code", "codex", "pi",
    /// "opencode", ...) — sniffed from headers or set per meter port.
    public var product: String?
    /// How `product` was established (nil when product is nil). Only ever
    /// .explicitLabel or .headerSniffed here — the meter's own observation.
    /// File attribution is stored separately (fileProduct) and ranked at
    /// query time; nothing is overwritten on write.
    public var productSource: ProductSource?
    /// How `cost` was established (nil = never priced). The meter's decision
    /// (.computed/.planFree/.unknown); a file-reported cost lives in fileCost.
    public var costSource: CostSource?
    /// Pseudonymous account the request was billed to (see AccountKey) —
    /// multi-account vendors consolidate usage and limits per account.
    public var accountID: String?
    /// Tool attribution joined from session files at READ time (LEFT JOIN on
    /// request id). Kept alongside — never merged into — the meter's own
    /// product label, so no observation is lost.
    public var fileProduct: String?
    /// Tool/provider-reported cost joined from session files at READ time.
    public var fileCost: Double?
    /// USD-equivalent list cost, computed at READ time from catalog rates ×
    /// token breakdown (input/output/cache-read/cache-write at their own
    /// rates). Identical normalization for subscription and API-billed
    /// requests — `costSource` is the label saying whether `cost` was an
    /// actual charge (.computed/.reported) or zero-marginal plan usage
    /// (.planFree). nil when the catalog doesn't price this model.
    public var costEquivalent: Double?
    /// Provider request id, when a channel exposes it: claude `requestId` in
    /// transcripts == `request-id` response header on the wire; OpenAI-style
    /// body `id` (chatcmpl-/resp-) == pi's `responseId`. The strong
    /// cross-channel dedup key; nil → heuristic (vendor+tokens+window) match.
    public var requestID: String?
    /// SECOND provider id for the same request when the wire format has two
    /// (Anthropic: `request-id` header is primary, body `id` msg_... is the
    /// id pi-style tools persist as responseId). File annotations join on
    /// either.
    public var requestIDAlt: String?
    public var attestation: Attestation

    public init(id: UUID = UUID(), timestamp: Date = Date(), machineID: String,
                machineAlias: String? = nil,
                source: SourceKind, vendor: String, model: String,
                tokens: TokenBreakdown, contextOccupancy: Int? = nil,
                contextLimit: Int? = nil, cost: Double = 0,
                promptTokPerSec: Double? = nil, generationTokPerSec: Double? = nil,
                latencyMs: Int? = nil, sessionID: String? = nil,
                thinkingLevel: String? = nil, thinkingRaw: String? = nil,
                product: String? = nil, productSource: ProductSource? = nil,
                costSource: CostSource? = nil, accountID: String? = nil,
                fileProduct: String? = nil, fileCost: Double? = nil,
                costEquivalent: Double? = nil,
                requestID: String? = nil, requestIDAlt: String? = nil,
                attestation: Attestation = .selfReported) {
        self.id = id
        self.timestamp = timestamp
        self.machineID = machineID
        self.machineAlias = machineAlias
        self.source = source
        self.vendor = vendor
        self.model = model
        self.tokens = tokens
        self.contextOccupancy = contextOccupancy
        self.contextLimit = contextLimit
        self.cost = cost
        self.promptTokPerSec = promptTokPerSec
        self.generationTokPerSec = generationTokPerSec
        self.latencyMs = latencyMs
        self.sessionID = sessionID
        self.thinkingLevel = thinkingLevel
        self.thinkingRaw = thinkingRaw
        self.product = product
        self.productSource = productSource
        self.costSource = costSource
        self.accountID = accountID
        self.fileProduct = fileProduct
        self.fileCost = fileCost
        self.costEquivalent = costEquivalent
        self.requestID = requestID
        self.requestIDAlt = requestIDAlt
        self.attestation = attestation
    }

    // MARK: - Query-time resolution (ranks decided on read, nothing merged on write)

    /// Wire encoding resolves the query-time RANKS: API consumers receive
    /// `product`/`cost` as the EFFECTIVE values (file-joined attribution
    /// outranks header sniff; file-reported cost outranks computed), with the
    /// meter's own raw observations riding along as `productRaw`/`costRaw`.
    /// Decoding stays synthesized over the stored fields (no rank applied).
    private enum WireKeys: String, CodingKey {
        case id, timestamp, machineID, machineAlias, source, vendor, model, tokens
        case contextOccupancy, contextLimit, cost, promptTokPerSec, generationTokPerSec
        case latencyMs, sessionID, thinkingLevel, thinkingRaw
        case product, productRaw, productSource, costRaw, costSource
        case accountID, fileProduct, fileCost, costEquivalent
        case requestID, requestIDAlt, attestation
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: WireKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(timestamp, forKey: .timestamp)
        try c.encode(machineID, forKey: .machineID)
        try c.encodeIfPresent(machineAlias, forKey: .machineAlias)
        try c.encode(source, forKey: .source)
        try c.encode(vendor, forKey: .vendor)
        try c.encode(model, forKey: .model)
        try c.encode(tokens, forKey: .tokens)
        try c.encodeIfPresent(contextOccupancy, forKey: .contextOccupancy)
        try c.encodeIfPresent(contextLimit, forKey: .contextLimit)
        try c.encode(effectiveCost, forKey: .cost)          // rank-resolved
        try c.encode(cost, forKey: .costRaw)                // meter's observation
        try c.encodeIfPresent(promptTokPerSec, forKey: .promptTokPerSec)
        try c.encodeIfPresent(generationTokPerSec, forKey: .generationTokPerSec)
        try c.encodeIfPresent(latencyMs, forKey: .latencyMs)
        try c.encodeIfPresent(sessionID, forKey: .sessionID)
        try c.encodeIfPresent(thinkingLevel, forKey: .thinkingLevel)
        try c.encodeIfPresent(thinkingRaw, forKey: .thinkingRaw)
        try c.encodeIfPresent(effectiveProduct, forKey: .product)  // rank-resolved
        try c.encodeIfPresent(product, forKey: .productRaw)        // meter's observation
        try c.encodeIfPresent(productSource, forKey: .productSource)
        try c.encodeIfPresent(costSource, forKey: .costSource)
        try c.encodeIfPresent(accountID, forKey: .accountID)
        try c.encodeIfPresent(fileProduct, forKey: .fileProduct)
        try c.encodeIfPresent(fileCost, forKey: .fileCost)
        try c.encodeIfPresent(costEquivalent, forKey: .costEquivalent)
        try c.encodeIfPresent(requestID, forKey: .requestID)
        try c.encodeIfPresent(requestIDAlt, forKey: .requestIDAlt)
        try c.encode(attestation, forKey: .attestation)
    }

    /// Effective tool label: an operator-pinned port label outranks the
    /// tool's own file record, which outranks header sniffing.
    public var effectiveProduct: String? {
        if productSource == .explicitLabel { return product }
        return fileProduct ?? product
    }

    /// Effective cost: the tool/provider-REPORTED figure (actual billed plan)
    /// outranks the meter's computed/plan decision.
    public var effectiveCost: Double { fileCost ?? cost }

    /// Provenance of `effectiveCost`.
    public var effectiveCostSource: CostSource? { fileCost != nil ? .reported : costSource }

    /// Canonical vendor spelling — computed at query time; the stored value
    /// is the raw source spelling.
    public var canonicalVendor: String { Canonical.vendor(vendor) }

    /// Canonical model spelling — computed at query time.
    public var canonicalModel: String { Canonical.model(vendor: vendor, model: model) }
}

/// Live context-window occupancy of one client session. This is *state*, not
/// an event: it moves as the conversation grows and is upserted per session.
public struct ContextState: Codable {
    public var sessionID: String
    public var vendor: String
    public var model: String
    public var occupancy: Int
    public var limit: Int
    public var updatedAt: Date

    public init(sessionID: String, vendor: String, model: String,
                occupancy: Int, limit: Int, updatedAt: Date = Date()) {
        self.sessionID = sessionID
        self.vendor = vendor
        self.model = model
        self.occupancy = occupancy
        self.limit = limit
        self.updatedAt = updatedAt
    }

    public var fillFraction: Double {
        limit > 0 ? Double(occupancy) / Double(limit) : 0
    }
}

/// Stable per-machine identity for multi-machine aggregation. Persisted as a
/// UUID in the config dir on first use; user-resettable by deleting the file.
public enum MachineIdentity {
    private static var cached: String?
    private static var cachedAlias: String?
    private static let lock = NSLock()

    public static var current: String {
        lock.lock(); defer { lock.unlock() }
        if let cached { return cached }
        let url = Platform.paths.configDirectory.appendingPathComponent("machine-id")
        if let data = try? Data(contentsOf: url),
           let id = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !id.isEmpty {
            cached = id
            return id
        }
        let id = UUID().uuidString
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? id.data(using: .utf8)?.write(to: url, options: .atomic)
        chmod(url.path, 0o600)
        cached = id
        return id
    }

    /// Human-readable alias INFERRED on top of the machine id — for display
    /// and multi-machine usability (UI pickers, cloud leaderboards). The id
    /// remains the identity; the alias is a label and may collide.
    ///
    /// Resolution order:
    /// 1. TH_MACHINE_ALIAS environment variable
    /// 2. `machine-alias` file in the config dir (user override)
    /// 3. the machine's hostname, sanitized (".local"/".lan" stripped)
    /// 4. "machine-<id prefix>" as a last resort
    public static var alias: String {
        lock.lock(); defer { lock.unlock() }
        if let cachedAlias { return cachedAlias }
        let resolved: String
        if let env = ProcessInfo.processInfo.environment["TH_MACHINE_ALIAS"],
           !env.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            resolved = env
        } else if let data = try? Data(contentsOf: Platform.paths.configDirectory
                                        .appendingPathComponent("machine-alias")),
                  let file = String(data: data, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines), !file.isEmpty {
            resolved = file
        } else {
            var host = ProcessInfo.processInfo.hostName
            for suffix in [".local", ".lan"] {
                if host.hasSuffix(suffix) { host = String(host.dropLast(suffix.count)) }
            }
            resolved = host
        }
        var alias = sanitizedAlias(resolved)
        if alias.isEmpty {
            alias = "machine-\(String(current.prefix(8)).lowercased())"
        }
        cachedAlias = alias
        return alias
    }

    /// Lowercase slug: [a-z0-9] kept, everything else folds to single
    /// dashes; capped at 32 chars.
    public static func sanitizedAlias(_ raw: String) -> String {
        var out = ""
        var lastWasDash = true   // trims leading dashes
        for scalar in raw.lowercased().unicodeScalars {
            let isAlnum = (scalar.value >= 97 && scalar.value <= 122)
                || (scalar.value >= 48 && scalar.value <= 57)
            if isAlnum {
                out.append(Character(scalar))
                lastWasDash = false
            } else if !lastWasDash {
                out.append("-")
                lastWasDash = true
            }
            if out.count >= 32 { break }
        }
        while out.hasSuffix("-") { out.removeLast() }
        return out
    }
}
