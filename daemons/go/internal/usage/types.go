package usage

// Shared measurement-contract DTOs (the types every subsystem exchanges):
// TokenBreakdown NET semantics (identical to Models.swift): input EXCLUDES
// cacheRead/cacheWrite, output EXCLUDES reasoning — wire subsets are
// subtracted at write time by the meter, so total == provider ground truth.
// Stored vendor/model spellings are RAW; canonicalization is read-time only.

type TokenBreakdown struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	Reasoning  int64 `json:"reasoning"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
}

func (t TokenBreakdown) Total() int64 {
	return t.Input + t.Output + t.Reasoning + t.CacheRead + t.CacheWrite
}

// Event mirrors UsageEvent's wire encoding (camelCase keys; cost/product are
// the EFFECTIVE rank-resolved values, costRaw/productRaw the meter's own).
type Event struct {
	ID                  string         `json:"id"`
	Timestamp           int64          `json:"timestamp"`
	MachineID           string         `json:"machineID"`
	MachineAlias        *string        `json:"machineAlias,omitempty"`
	Source              string         `json:"source"`
	Vendor              string         `json:"vendor"`
	Model               string         `json:"model"`
	Tokens              TokenBreakdown `json:"tokens"`
	ContextOccupancy    *int64         `json:"contextOccupancy,omitempty"`
	ContextLimit        *int64         `json:"contextLimit,omitempty"`
	Cost                float64        `json:"cost"`
	CostRaw             float64        `json:"costRaw"`
	PromptTokPerSec     *float64       `json:"promptTokPerSec,omitempty"`
	GenerationTokPerSec *float64       `json:"generationTokPerSec,omitempty"`
	LatencyMs           *int64         `json:"latencyMs,omitempty"`
	SessionID           *string        `json:"sessionID,omitempty"`
	ThinkingLevel       *string        `json:"thinkingLevel,omitempty"`
	ThinkingRaw         *string        `json:"thinkingRaw,omitempty"`
	Product             *string        `json:"product,omitempty"`
	ProductRaw          *string        `json:"productRaw,omitempty"`
	ProductSource       *string        `json:"productSource,omitempty"`
	CostSource          *string        `json:"costSource,omitempty"`
	AccountID           *string        `json:"accountID,omitempty"`
	FileProduct         *string        `json:"fileProduct,omitempty"`
	FileCost            *float64       `json:"fileCost,omitempty"`
	CostEquivalent      *float64       `json:"costEquivalent,omitempty"`
	RequestID           *string        `json:"requestID,omitempty"`
	RequestIDAlt        *string        `json:"requestIDAlt,omitempty"`
	Attestation         string         `json:"attestation"`
}

// LimitSnapshot mirrors the Swift DTO (epoch seconds on the wire).
type LimitSnapshot struct {
	RecordedAt  int64   `json:"recorded_at"`
	MachineID   string  `json:"machine_id"`
	Provider    string  `json:"provider"`
	AccountID   string  `json:"account_id"`
	Label       string  `json:"label"`
	UsedPercent float64 `json:"used_percent"`
	ResetsAt    *int64  `json:"resets_at"`
	Detail      string  `json:"detail"`
}

// FileAnnotation: a file's own claim of tool identity + tool-reported
// cost, keyed by provider request id; LEFT JOINed onto metered rows at
// READ time (files never create or modify usage rows).
type FileAnnotation struct {
	Vendor     string
	RequestID  string
	Product    string
	Cost       *float64
	Timestamp  int64
	SourceFile string
}
