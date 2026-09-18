// Provider/runtime accent palette — true brand colors. Monochrome brands
// (opencode, xAI) use light-dark() graphite/black so they read in both
// themes. Runtimes share mint; unknown vendors get a deterministic hue.

const ACCENTS: Record<string, string> = {
	// cloud vendors
	claude: '#d97757',
	anthropic: '#d97757',
	opencode: 'light-dark(#52525b, #a1a1aa)',
	muse: 'light-dark(#52525b, #a1a1aa)',
	'x-preview': 'light-dark(#52525b, #a1a1aa)',
	codex: '#10a37f',
	openai: '#10a37f',
	minimax: '#f24d40',
	'minimax-coding-plan': '#f24d40',
	kimi: '#7a47e0',
	'kimi-coding': '#7a47e0',
	'kimi-coding-plan': '#7a47e0',
	moonshot: '#7a47e0',
	glm: '#2e6bf0',
	zai: '#2e6bf0',
	'zai-coding-plan': '#2e6bf0',
	zhipu: '#2e6bf0',
	qwen: '#615ced',
	'qwen-coder': '#615ced',
	grok: 'light-dark(#09090b, #fafafa)',
	xai: 'light-dark(#09090b, #fafafa)',
	gemini: '#1a73e8',
	google: '#1a73e8',
	agy: '#612ef2',
	antigravity: '#612ef2',
	deepseek: '#1485eb',
	'deepseek-v4-pro': '#1485eb',
	alibaba: '#ff6a00',
	'alibaba-token-plan': '#ff6a00',
	// self-managed runtimes — per-runtime brand colors
	ollama: 'light-dark(#44403c, #d6d3d1)',
	mlx: '#6b7280',
	localllm: '#2ed3b7',
	'luh-crank': '#2ed3b7',
	vllm: '#0d9488',
	sglang: '#f59e0b',
	llamacpp: '#0082fa',
	llama: '#0082fa'
};

/** Activity green (light/dark) — the single heat source for heatmaps,
 *  widget dots and streak accents. Banding lives in heatLevel(). */
export const HEAT = 'light-dark(#34c759, #30d158)';

export function providerAccent(key: string): string {
	const k = key.toLowerCase();
	const hit = ACCENTS[k];
	if (hit) return hit;
	// Deterministic fallback so unknown providers still get a stable color.
	let h = 0;
	for (const c of k) h = (h * 31 + c.charCodeAt(0)) % 360;
	return `hsl(${h} 60% 55%)`;
}
