// Curated provider popularity — editorial order, not measured traffic.
// Traffic-based sorts reshuffle as you work (and differ per machine);
// this order only changes when someone edits this file. Unknown vendors
// sort last, alphabetically.
const ORDER = [
	'claude',
	'codex',
	'openai',
	'gemini',
	'kimi',
	'deepseek',
	'opencode-go',
	'glm',
	'zhipu',
	'alibaba',
	'qwen',
	'minimax',
	'grok',
	'xai',
	'ollama',
	'vllm',
	'sglang',
	'llamacpp',
	'mlx'
];

const RANK = new Map(ORDER.map((v, i) => [v, i] as const));

export function providerRank(vendor: string): number {
	return RANK.get(vendor.toLowerCase()) ?? ORDER.length;
}

/** Popularity order, alphabetical tiebreak (unknowns last). */
export function compareProviders(a: string, b: string): number {
	return providerRank(a) - providerRank(b) || a.localeCompare(b);
}
