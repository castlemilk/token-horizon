// Provider/runtime accent palette — 1:1 port of the macOS app's `toolColor`
// (DashboardTabs.swift) so chart colors stay cohesive across platforms.
// Runtimes share the mint family; unknown vendors get a deterministic hue.

const ACCENTS: Record<string, string> = {
	// cloud vendors
	claude: '#f97316',
	anthropic: '#f97316',
	opencode: '#22c55e',
	muse: '#22c55e',
	'x-preview': '#22c55e',
	'deepseek-v4-pro': '#22c55e',
	codex: '#06b6d4',
	openai: '#06b6d4',
	minimax: '#06b6d4',
	'minimax-coding-plan': '#06b6d4',
	kimi: '#a855f7',
	'kimi-coding': '#a855f7',
	'kimi-coding-plan': '#a855f7',
	moonshot: '#a855f7',
	glm: '#eab308',
	zai: '#eab308',
	'zai-coding-plan': '#eab308',
	zhipu: '#eab308',
	qwen: '#3b82f6',
	'qwen-coder': '#3b82f6',
	grok: '#ec4899',
	xai: '#ec4899',
	gemini: '#4285f4',
	google: '#4285f4',
	agy: '#a673f2',
	antigravity: '#a673f2',
	deepseek: '#14b8a6',
	alibaba: '#14b8a6',
	'alibaba-token-plan': '#14b8a6',
	// self-managed runtimes (macOS: ollama/mlx/localllm mint)
	ollama: '#2ed3b7',
	mlx: '#2ed3b7',
	localllm: '#2ed3b7',
	'luh-crank': '#2ed3b7',
	vllm: '#2ed3b7',
	sglang: '#2ed3b7',
	llamacpp: '#2ed3b7',
	llama: '#2ed3b7'
};

export function providerAccent(key: string): string {
	const k = key.toLowerCase();
	const hit = ACCENTS[k];
	if (hit) return hit;
	// Deterministic fallback so unknown providers still get a stable color.
	let h = 0;
	for (const c of k) h = (h * 31 + c.charCodeAt(0)) % 360;
	return `hsl(${h} 60% 55%)`;
}
