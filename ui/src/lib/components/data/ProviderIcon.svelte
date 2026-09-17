<script lang="ts" module>
	// Brand chips for providers/vendors — 1:1 port of the macOS app's
	// ProviderLogos.swift (hand-drawn glyphs, NOT trademark logos): brand
	// background + white glyph on a rounded square. Unknown vendors fall
	// back to a deterministic-accent chip with a two-letter monogram.
	import { providerAccent } from '$lib/colors';

	export type Glyph =
		| 'asterisk' | 'swirl' | 'sparkle' | 'delta' | 'fin' | 'prism' | 'orbit'
		| 'llama' | 'steps' | 'sun'
		| 'K' | 'M' | 'X' | 'inf' | 'prompt' | 'mono';

	export interface Brand {
		bg: string;
		glyph: Glyph;
		/** Monogram for the 'mono' fallback glyph. */
		letters: string;
	}

	/* Raster brand marks in /icons/ (webp, alpha). iconKey() maps a
	   vendor/model hint to a file basename; HAS_DARK lists which have a
	   `-dark.webp` variant. Missing keys fall back to the glyph chips. */
	// Single-variant keys that always serve their -dark file in both
	// themes (transparent light glyph).
	const SINGLE_DARK = new Set(['kimi']);
	const HAS_DARK = new Set([
		'anthropic', 'linux', 'mlx', 'moonshot', 'ollama', 'openai', 'opencode', 'pi'
	]);

	export function iconKey(vendor: string, model = ''): string | null {
		const p = vendor.toLowerCase();
		const m = model.toLowerCase();
		if (p.includes('claude') || m.includes('claude')) return 'claude';
		if (p.includes('anthropic')) return 'anthropic';
		if (p.includes('openai') || p.includes('codex') || m.includes('gpt') || m.startsWith('o1') || m.startsWith('o3')) return 'openai';
		if (p.includes('google') || p.includes('gemini') || m.includes('gemini') || m.includes('gemma')) return 'gemini';
		if (p.includes('deepseek') || m.includes('deepseek')) return 'deepseek';
		if (p.includes('kimi') || m.includes('kimi')) return 'kimi';
		if (p.includes('moonshot')) return 'moonshot';
		if (p.includes('glm') || p.includes('zai') || p.includes('zhipu') || m.includes('glm')) return 'glm';
		if (p.includes('minimax') || m.includes('minimax')) return 'minimax';
		if (p.includes('qwen') || m.includes('qwen')) return 'qwen';
		if (p.includes('alibaba') || p.includes('bailian')) return 'alibaba';
		if (p.includes('ollama')) return 'ollama';
		if (p.includes('llamacpp') || p.includes('llama.cpp') || p.includes('llama-cpp')) return 'llamacpp';
		if (p.includes('vllm')) return 'vllm';
		if (p.includes('sglang')) return 'sglang';
		if (p.includes('mlx')) return 'mlx';
		if (p.includes('opencode') || p.includes('muse') || m.includes('x-preview')) return 'opencode';
		if (p === 'pi' || p.startsWith('pi ') || p.startsWith('pi-')) return 'pi';
		return null;
	}

	export function iconHasDark(key: string): boolean {
		return HAS_DARK.has(key);
	}

	// Background colors (Swift Color 0..1 → hex), same precedence as macOS.
	export function brand(vendor: string, model = ''): Brand {
		const p = vendor.toLowerCase();
		const m = model.toLowerCase();
		const mono = (s: string): Brand => ({
			bg: providerAccent(vendor),
			glyph: 'mono',
			letters: s.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '??'
		});
		if (p.includes('anthropic') || p.includes('claude') || m.includes('claude'))
			return { bg: '#d97857', glyph: 'asterisk', letters: '' };
		if (p.includes('openai') || p.includes('codex') || m.includes('gpt') || m.startsWith('o1') || m.startsWith('o3'))
			return { bg: '#0fa380', glyph: 'swirl', letters: '' };
		if (p.includes('google') || p.includes('gemini') || m.includes('gemini') || m.includes('gemma'))
			return { bg: '#2666f0', glyph: 'sparkle', letters: '' };
		if (p.includes('agy') || p.includes('antigravity'))
			return { bg: '#612ef2', glyph: 'delta', letters: '' };
		if (p.includes('deepseek') || m.includes('deepseek'))
			return { bg: '#1485eb', glyph: 'fin', letters: '' };
		if (p.includes('kimi') || p.includes('moonshot') || m.includes('kimi'))
			return { bg: '#7a47e0', glyph: 'K', letters: '' };
		if (p.includes('glm') || p.includes('zai') || p.includes('zhipu') || m.includes('glm'))
			return { bg: '#1f70f2', glyph: 'prism', letters: '' };
		if (p.includes('minimax') || m.includes('minimax'))
			return { bg: '#f24d40', glyph: 'M', letters: '' };
		if (p.includes('alibaba') || p.includes('qwen') || p.includes('bailian') || m.includes('qwen'))
			return { bg: '#ff6b00', glyph: 'orbit', letters: '' };
		if (p.includes('upstage') || m.includes('solar'))
			return { bg: '#6b52f2', glyph: 'sun', letters: '' };
		if (p.includes('xai') || p.includes('grok') || m.includes('grok'))
			return { bg: '#242429', glyph: 'X', letters: '' };
		if (p.includes('ollama'))
			return { bg: '#2e2e38', glyph: 'llama', letters: '' };
		if (p.includes('mistral') || m.includes('codestral') || m.includes('mistral'))
			return { bg: '#f2660d', glyph: 'steps', letters: '' };
		if (p.includes('meta') || m.includes('llama'))
			return { bg: '#0082fa', glyph: 'inf', letters: '' };
		if (p.includes('opencode') || p.includes('muse') || m.includes('muse') || m.includes('x-preview'))
			return { bg: '#0fa66b', glyph: 'prompt', letters: '' };
		return mono(m || p);
	}

	/** OpenAI swirl: 6 arcs (geometry ported from OpenAISwirlShape). */
	export function swirlPath(): string {
		const c = 12;
		const r = 24 * 0.42;
		let d = '';
		for (let i = 0; i < 6; i++) {
			const a = (i * Math.PI) / 3;
			const p1x = c + Math.cos(a) * r * 0.4;
			const p1y = c + Math.sin(a) * r * 0.4;
			const p2x = c + Math.cos(a + 0.8) * r;
			const p2y = c + Math.sin(a + 0.8) * r;
			const cx = c + Math.cos(a + 0.4) * r * 1.1;
			const cy = c + Math.sin(a + 0.4) * r * 1.1;
			d += `M${p1x.toFixed(2)},${p1y.toFixed(2)} Q${cx.toFixed(2)},${cy.toFixed(2)} ${p2x.toFixed(2)},${p2y.toFixed(2)} `;
		}
		return d.trim();
	}

	/** Anthropic asterisk: 8 spokes. */
	export function asteriskPath(): string {
		let d = '';
		for (let i = 0; i < 8; i++) {
			const a = i * (Math.PI / 4);
			d += `M12,12 L${(12 + Math.cos(a) * 10).toFixed(2)},${(12 + Math.sin(a) * 10).toFixed(2)} `;
		}
		return d.trim();
	}

	/** Upstage sun: rays only (circle drawn as element). */
	export function sunRays(): string {
		let d = '';
		for (let i = 0; i < 8; i++) {
			const a = i * (Math.PI / 4);
			d += `M${(12 + Math.cos(a) * 6.8).toFixed(2)},${(12 + Math.sin(a) * 6.8).toFixed(2)} L${(12 + Math.cos(a) * 10).toFixed(2)},${(12 + Math.sin(a) * 10).toFixed(2)} `;
		}
		return d.trim();
	}
</script>

<script lang="ts">
	let { vendor, model = '', size = 16 }: { vendor: string; model?: string; size?: number } =
		$props();

	const b = $derived(brand(vendor, model));
	const key = $derived(iconKey(vendor, model));
	const radius = $derived(size * 0.28);
</script>

{#if key}
<span
	class="picon raster"
	class:single={SINGLE_DARK.has(key)}
	role="img"
	aria-label={vendor}
	style="width:{size}px;height:{size}px;border-radius:{radius}px"
>
	{#if SINGLE_DARK.has(key)}
		<img src="/icons/{key}-dark.webp" alt="" width={size} height={size} draggable="false" />
	{:else if iconHasDark(key)}
		<img class="light-var" src="/icons/{key}.webp" alt="" width={size} height={size} draggable="false" />
		<img class="dark-var" src="/icons/{key}-dark.webp" alt="" width={size} height={size} draggable="false" />
	{:else}
		<img src="/icons/{key}.webp" alt="" width={size} height={size} draggable="false" />
	{/if}
</span>
{:else}
<span
	class="picon"
	role="img"
	aria-label={vendor}
	style="width:{size}px;height:{size}px;border-radius:{radius}px;background:{b.bg}"
>
	<svg viewBox="0 0 24 24" width={size * 0.72} height={size * 0.72} aria-hidden="true">
		{#if b.glyph === 'asterisk'}
			<path d={asteriskPath()} stroke="#fff" stroke-width="3.8" stroke-linecap="round" />
		{:else if b.glyph === 'swirl'}
			<path d={swirlPath()} fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" />
		{:else if b.glyph === 'sparkle'}
			<path d="M12,0 Q14.6,9.4 24,12 Q14.6,14.6 12,24 Q9.4,14.6 0,12 Q9.4,9.4 12,0 Z" fill="#fff" />
		{:else if b.glyph === 'delta'}
			<path d="M12,2.9 L21.1,20.4 L2.9,20.4 Z" fill="#fff" />
		{:else if b.glyph === 'fin'}
			<path d="M3.6,20.4 C7.2,19.2 14.4,7.2 20.4,6 Q19.2,16.8 13.2,20.4 Z" fill="#fff" />
		{:else if b.glyph === 'prism'}
			<path d="M12,1.2 L22.8,12 L12,22.8 L1.2,12 Z" fill="#fff" />
		{:else if b.glyph === 'orbit'}
			<circle cx="12" cy="12" r="9.6" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" />
			<path d="M14.4,14.4 L21.6,21.6" stroke="#fff" stroke-width="3.4" stroke-linecap="round" />
		{:else if b.glyph === 'llama'}
			<path d="M6,20.4 L6,8.4 L9.1,2.4 L11.5,8.4 L14.4,2.4 L16.8,8.4 L20.4,13.2 L20.4,18 L15.6,20.4 Z" fill="#40e6b3" />
		{:else if b.glyph === 'steps'}
			<rect x="0" y="15.6" width="4.32" height="8.4" rx="1" fill="#fff" />
			<rect x="5.76" y="8.4" width="4.32" height="15.6" rx="1" fill="#fff" />
			<rect x="11.52" y="1.2" width="4.32" height="22.8" rx="1" fill="#fff" />
			<rect x="17.28" y="12" width="4.32" height="12" rx="1" fill="#fff" />
		{:else if b.glyph === 'sun'}
			<circle cx="12" cy="12" r="4.4" fill="#fff" />
			<path d={sunRays()} stroke="#fff" stroke-width="2.4" stroke-linecap="round" />
		{:else if b.glyph === 'K'}
			<text x="12" y="12.5" class="g-text" font-size="15" font-weight="800">K</text>
		{:else if b.glyph === 'M'}
			<text x="12" y="12.5" class="g-text" font-size="15" font-weight="800">M</text>
		{:else if b.glyph === 'X'}
			<text x="12" y="12.5" class="g-text" font-size="14" font-weight="700">𝕏</text>
		{:else if b.glyph === 'inf'}
			<text x="12" y="12.5" class="g-text" font-size="17" font-weight="700">∞</text>
		{:else if b.glyph === 'prompt'}
			<text x="12" y="12.5" class="g-text mono" font-size="10.5" font-weight="800">&gt;_</text>
		{:else}
			<text x="12" y="12.5" class="g-text mono" font-size="9" font-weight="800">{b.letters}</text>
		{/if}
	</svg>
</span>
{/if}

<style>
	.picon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		box-shadow:
		inset 0 0 0 1px rgb(255 255 255 / 0.14),
		0 1px 1px rgb(0 0 0 / 0.2);
	}
	.g-text {
		fill: #fff;
		text-anchor: middle;
		dominant-baseline: central;
		font-family: ui-rounded, system-ui, sans-serif;
	}
	.g-text.mono {
		font-family: var(--font-mono, ui-monospace, monospace);
	}
	.picon.raster {
		box-shadow: none;
		overflow: hidden;
	}
	/* single-variant light glyphs ride a dark chip so they read
	   identically in both themes */
	.picon.raster.single {
		background: #1c1c22;
		box-shadow:
			inset 0 0 0 1px rgb(255 255 255 / 0.14),
			0 1px 1px rgb(0 0 0 / 0.2);
	}
	.picon.raster.single img {
		width: 78%;
		height: 78%;
		margin: auto;
	}
	.picon.raster img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		display: block;
	}
	.picon.raster img.dark-var {
		display: none;
	}
	/* manual dark override */
	:global(html[data-theme='dark']) .picon.raster img.light-var {
		display: none;
	}
	:global(html[data-theme='dark']) .picon.raster img.dark-var {
		display: block;
	}
	/* system dark (no manual override) */
	@media (prefers-color-scheme: dark) {
		:global(html:not([data-theme='light'])) .picon.raster img.light-var {
			display: none;
		}
		:global(html:not([data-theme='light'])) .picon.raster img.dark-var {
			display: block;
		}
	}
</style>
