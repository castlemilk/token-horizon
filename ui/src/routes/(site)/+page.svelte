<script lang="ts">
	// The marketing landing page (website root). Monumental-chrome guide:
	// near-black grain stage, massive arched chrome headline, giant grey
	// statement type, numbered annotation columns, hairlines only.
	// All copy is unchanged — this is a pure reskin. Styles scoped here.
	import { onMount } from 'svelte';

	const installCmd =
		'curl -fsSL https://raw.githubusercontent.com/castlemilk/token-horizon/main/install.sh | bash';

	// Providers (+ local runtimes) vs. coding-agent tools — served from
	// /icons/ (light-surface variants throughout; darkened to sit on black).
	// `file` is the exact webp basename. Providers carry the vendor name
	// (Anthropic, OpenAI); tools carry the agent name (Claude, Codex).
	// `dark` is the light-artwork variant for the black stage — the plain
	// webp originals of these marks are near-black and vanish on dark.
	const sections: { label: string; marquee: boolean; items: { file: string; dark?: string; name: string }[] }[] = [
		{
			label: 'Providers & Runtimes',
			marquee: true,
			items: [
				{ file: 'anthropic.webp', dark: 'anthropic-dark.webp', name: 'Anthropic' },
				{ file: 'openai.webp', dark: 'openai-dark.webp', name: 'OpenAI' },
				{ file: 'gemini.webp', name: 'Gemini' },
				{ file: 'moonshot.webp', dark: 'moonshot-dark.webp', name: 'Kimi' },
				{ file: 'minimax.webp', name: 'MiniMax' },
				{ file: 'opencode.webp', dark: 'opencode-dark.webp', name: 'OpenCode' },
				{ file: 'qwen.webp', name: 'Qwen' },
				{ file: 'deepseek.webp', name: 'DeepSeek' },
				{ file: 'glm.webp', name: 'GLM' },
				{ file: 'alibaba.webp', name: 'Alibaba' },
				{ file: 'ollama.webp', dark: 'ollama-dark.webp', name: 'Ollama' },
				{ file: 'vllm.webp', name: 'vLLM' },
				{ file: 'sglang.webp', name: 'SGLang' },
				{ file: 'llamacpp.webp', name: 'llama.cpp' },
				{ file: 'mlx.webp', dark: 'mlx-dark.webp', name: 'MLX' }
			]
		},
		{
			label: 'Tools',
			marquee: false,
			items: [
				{ file: 'claude.webp', name: 'Claude' },
				{ file: 'openai.webp', dark: 'openai-dark.webp', name: 'Codex' },
				{ file: 'opencode.webp', dark: 'opencode-dark.webp', name: 'opencode' },
				{ file: 'pi.webp', dark: 'pi-dark.webp', name: 'pi' }
			]
		}
	];

	let copied = $state(false);
	async function copyInstall() {
		try {
			await navigator.clipboard.writeText(installCmd);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			/* clipboard blocked — the command is right there to select */
		}
	}

	const features = [
		{
			n: '01',
			t: 'Tracking',
			d: 'Every request counted as it happens. Tokens and cost per model, per tool, per session, on cloud vendors and your own GPU. History survives restarts.'
		},
		{
			n: '02',
			t: 'Limits',
			d: 'Every plan quota and rate window on one screen, with reset times. You see the ceiling before you hit it.'
		},
		{
			n: '03',
			t: 'Leaderboards & Teams',
			d: 'Opt-in rankings across today, 7 days, all time, and streaks. Group your team to compare totals on the same board.'
		},
		{
			n: '04',
			t: 'Accounts',
			d: 'Sign in once and publish from any machine you run. Vendors with more than one login stay tracked separately.'
		},
		{
			n: '05',
			t: 'Privacy',
			d: 'Everything runs on your machine and meters need your permission first. Prompts are never logged and nothing is shared until you say so.'
		}
	];

	// Scroll reveals: sections rise in once as they enter view. Reduced-motion
	// users get everything static via the CSS guard below.
	onMount(() => {
		const els = Array.from(document.querySelectorAll('[data-reveal]'));
		if (!('IntersectionObserver' in window)) {
			els.forEach((el) => el.classList.add('in'));
			return;
		}
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (e.isIntersecting) {
						e.target.classList.add('in');
						io.unobserve(e.target);
					}
				}
			},
			{ threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
		);
		els.forEach((el) => io.observe(el));
		return () => io.disconnect();
	});
</script>

<svelte:head>
	<title>Token Horizon · Your AI usage. On the horizon.</title>
	<meta
		name="description"
		content="Token Horizon tracks what you use and what you spend across every AI coding tool you run. Tokens, costs, and plan limits in one place. Private until you choose to share."
	/>
</svelte:head>

<div class="grain" aria-hidden="true"></div>

<header class="hero" id="top">
	<div class="hero-inner" data-reveal>
		<div class="hero-top">
			<span class="eyebrow">● Local-first AI metering</span>
			<p class="hero-meta">
				Every request counted as it happens<br />
				Tokens · Costs · Plan limits
			</p>
		</div>
		<h1>Token Horizon</h1>
		<p class="sub">
			<strong>Your AI usage. On the horizon.</strong> Token Horizon tracks what you use and
			what you spend across every AI coding tool you run, from Claude and Codex to the
			models on your own GPU.
		</p>
		<div class="hero-ctas">
			<a class="cta cta-solid" href="#install">Install now</a>
			<a class="cta cta-ghost" href="/leaderboard">View leaderboard ↗</a>
		</div>
		<ul class="platforms-supported" aria-label="Supported platforms">
			<li><img src="/icons/macos.webp" alt="" width="20" height="20" />macOS</li>
			<li><img src="/icons/windows.webp" alt="" width="20" height="20" />Windows</li>
			<li><img src="/icons/linux-dark.webp" alt="" width="20" height="20" />Linux</li>
		</ul>
	</div>
</header>

<main id="main">
	{#each sections as s}
		{#if s.marquee}
			<div class="wall" aria-label="Supported {s.label.toLowerCase()}" data-reveal>
				<div class="wall-grid">
					{#each s.items as b}
						{@const src = `/icons/${b.dark ?? b.file}`}
						<span class="wcell" title={b.name}>
							<img {src} alt={b.name} loading="lazy" />
							<span class="wname">{b.name}</span>
						</span>
					{/each}
				</div>
			</div>
		{:else}
			<div class="carousel static" aria-label="Supported {s.label.toLowerCase()}" data-reveal>
				<p class="carousel-label">{s.label}</p>
				<div class="carousel-track">
					{#each s.items as b}
						{@const src = `/icons/${b.dark ?? b.file}`}
						<span class="vcell" title={b.name}>
							<img {src} alt={b.name} loading="lazy" />
							{b.name}
						</span>
					{/each}
				</div>
			</div>
		{/if}
	{/each}

	<section class="section statement">
		<div class="section-inner" id="features" data-reveal>
			<span class="slabel">01 — The pieces</span>
			<h2 class="sr">What you get.</h2>
			<p class="giant">
				One daemon, one database, every number in the same place — from the first
				token of the day to the quota reset next week.
			</p>
			<div class="feat-grid">
				{#each features as f, i}
					<article class="feat" data-reveal style="transition-delay:{i * 70}ms">
						<span class="fnum">{f.n}</span>
						<h3>{f.t}</h3>
						<p>{f.d}</p>
					</article>
				{/each}
			</div>
		</div>
	</section>

	<section class="section install" id="install">
		<div class="section-inner" data-reveal>
			<span class="slabel">02 — Install</span>
			<h2>Up in a minute.</h2>
			<div class="copyline">
				<code>{installCmd}</code>
				<button type="button" onclick={copyInstall} aria-label="Copy install command">
					{copied ? 'Copied' : 'Copy'}
				</button>
			</div>
			<div class="install-grid">
				<article class="install-card">
					<h3>One-liner</h3>
					<pre><code>{installCmd}</code></pre>
					<p>Latest release, no sudo, no prompts.</p>
				</article>
				<article class="install-card">
					<h3>Homebrew</h3>
					<pre><code>brew tap castlemilk/tap
brew install --cask token-horizon</code></pre>
					<p>Tracks releases through a versioned cask.</p>
				</article>
				<article class="install-card">
					<h3>Linux</h3>
					<pre><code>{installCmd}</code></pre>
					<p>Installs the daemon and registers it with your user session.</p>
				</article>
			</div>
		</div>
	</section>
</main>

<style>
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
		border: 0;
	}

	/* Film grain over the whole page — static texture, decorative only. */
	.grain {
		position: fixed;
		inset: 0;
		z-index: 60;
		pointer-events: none;
		opacity: 0.08;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.7'/%3E%3C/svg%3E");
	}

	.slabel {
		display: block;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		line-height: 1.6;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: #8e8e96;
		margin-bottom: 22px;
	}

	/* ---- scroll reveals (JS adds .in; reduced-motion guard at the end) ---- */
	[data-reveal] {
		opacity: 0;
		transform: translateY(16px);
		transition: opacity 0.7s ease, transform 0.7s ease;
	}
	/* .in is applied at runtime by the reveal observer, outside the
	   component's view — hence the global class hook. */
	[data-reveal]:global(.in) {
		opacity: 1;
		transform: none;
	}

	/* ---- hero ---- */
	.hero {
		display: grid;
		padding: 120px var(--page-pad-x) 96px;
	}
	.hero-inner {
		position: relative;
		max-width: 1200px;
		margin: 0 auto;
		width: 100%;
	}
	.hero-top {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 20px;
		margin-bottom: 10px;
	}
	.eyebrow {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: #8e8e96;
	}
	.hero-meta {
		margin: 0;
		text-align: right;
		font-size: 0.8125rem;
		font-weight: 700;
		line-height: 1.35;
		letter-spacing: -0.01em;
		color: #6d6d76;
	}

	/* Simple centered header — heavy grotesk wordmark, no effects. */
	.hero h1 {
		margin: 72px 0 0;
		text-align: center;
		font-family: var(--font-display);
		font-size: clamp(3rem, 9vw, 7rem);
		line-height: 0.95;
		letter-spacing: 0;
		text-transform: uppercase;
		color: #f5f5f6;
	}
	.sub {
		max-width: 600px;
		margin: 26px auto 0;
		text-align: center;
		font-size: 1rem;
		line-height: 1.55;
		color: #a7a7b0;
	}
	.sub strong {
		color: #f5f5f6;
		font-weight: 700;
	}
	.hero-ctas {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
		justify-content: center;
		margin-top: 34px;
	}
	.cta {
		display: inline-block;
		padding: 13px 30px;
		font-size: 0.9375rem;
		font-weight: 700;
		line-height: 1.25;
		text-decoration: none;
	}
	.cta:focus-visible {
		outline: 2px solid #f5f5f6;
		outline-offset: 3px;
	}
	.cta-solid {
		background: #f5f5f6;
		color: #08080a;
	}
	.cta-solid:hover {
		background: #fff;
	}
	.cta-ghost {
		border: 1px solid #333338;
		color: #f5f5f6;
	}
	.cta-ghost:hover {
		border-color: #f5f5f6;
	}
	.platforms-supported {
		display: flex;
		gap: 24px;
		flex-wrap: wrap;
		justify-content: center;
		list-style: none;
		margin: 44px 0 0;
		padding: 0;
	}
	.platforms-supported li {
		display: flex;
		align-items: center;
		gap: 9px;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #6d6d76;
	}
	.platforms-supported img {
		width: 20px;
		height: 20px;
		object-fit: contain;
		display: block;
	}

	/* ---- provider wall: hairline grid, invert on hover ---- */
	.wall {
		border-top: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
	}
	.wall-grid {
		display: grid;
		grid-template-columns: repeat(5, 1fr);
		max-width: 1200px;
		margin: 0 auto;
	}
	.wcell {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 14px;
		padding: 38px 20px 30px;
		border-left: 1px solid var(--border);
		border-top: 1px solid var(--border);
		margin-left: -1px;
		margin-top: -1px;
		transition: background 0.18s;
	}
	.wcell img {
		height: 52px;
		width: auto;
		display: block;
	}
	.wname {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: #6d6d76;
	}
	.wcell:hover {
		background: #f5f5f6;
	}
	.wcell:hover .wname {
		color: #08080a;
	}

	/* ---- tools showcase ---- */
	.carousel {
		overflow: hidden;
		border-top: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
		padding: 28px 0 32px;
	}
	.carousel-label {
		text-align: center;
		font-family: var(--font-mono);
		font-size: 0.625rem;
		line-height: 1.6;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: #6d6d76;
		margin: 0 0 22px;
	}
	.carousel-track {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 26px 72px;
		max-width: 1000px;
		margin: 0 auto;
		padding: 0 var(--page-pad-x);
	}
	.vcell {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		font-size: 0.9375rem;
		color: #f5f5f6;
		white-space: nowrap;
	}
	.vcell img {
		width: auto;
		height: 44px;
		display: block;
	}

	/* ---- sections ---- */
	.section {
		padding: 6rem var(--page-pad-x);
	}
	.section-inner {
		max-width: 1200px;
		margin: 0 auto;
	}
	.section h2 {
		font-family: var(--font-display);
		font-size: clamp(2rem, 5vw, 3.75rem);
		line-height: 1;
		letter-spacing: 0;
		text-transform: uppercase;
		color: #f5f5f6;
		margin: 0 0 var(--gap);
	}

	/* Giant grey statement + numbered annotation columns. */
	.giant {
		margin: 0 0 60px;
		font-size: clamp(1.65rem, 4.2vw, 3.25rem);
		font-weight: 700;
		line-height: 1.12;
		letter-spacing: -0.02em;
		color: #8e8e96;
		max-width: 20ch;
	}
	.feat-grid {
		display: grid;
		grid-template-columns: repeat(5, 1fr);
		gap: 30px;
		border-top: 1px solid var(--border);
		padding-top: 8px;
	}
	.feat {
		border-top: 1px solid var(--border);
		padding-top: 18px;
	}
	.fnum {
		display: block;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.12em;
		color: #6d6d76;
		margin-bottom: 12px;
	}
	.feat h3 {
		font-size: 0.9375rem;
		font-weight: 700;
		margin: 0 0 10px;
		color: #f5f5f6;
	}
	.feat p {
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.55;
		color: #8e8e96;
	}

	/* ---- install ---- */
	.install {
		border-top: 1px solid var(--border);
	}
	.copyline {
		display: flex;
		align-items: stretch;
		margin-bottom: 60px;
		border: 1px solid var(--border-light);
		background: #101014;
		max-width: 720px;
	}
	.copyline code {
		flex: 1;
		padding: 14px 19px;
		font: 400 0.875rem/1.429 var(--font-mono);
		color: #f5f5f6;
		overflow-x: auto;
		white-space: nowrap;
	}
	.copyline button {
		border: 0;
		border-left: 1px solid var(--border-light);
		background: transparent;
		color: #f5f5f6;
		padding: 0 18px;
		font-size: 0.875rem;
		font-weight: 700;
		cursor: pointer;
		min-width: 76px;
	}
	.copyline button:hover {
		background: #f5f5f6;
		color: #08080a;
	}
	.copyline button:focus-visible {
		outline: 2px solid #f5f5f6;
		outline-offset: -2px;
	}
	.install-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: var(--gap);
	}
	.install-card {
		border: 1px solid var(--border);
		background: #101014;
		padding: var(--gap);
	}
	.install-card h3 {
		font-size: 1rem;
		font-weight: 700;
		color: #f5f5f6;
		margin: 0 0 14px;
	}
	.install-card p {
		margin: 14px 0 0;
		font-size: 0.875rem;
		color: #8e8e96;
	}
	.install-card pre {
		margin: 0;
		padding: 14px;
		overflow-x: auto;
		border: 1px solid var(--border);
		background: #08080a;
		font: 400 0.8125rem/1.5 var(--font-mono);
		color: #c9c9d1;
	}

	@media (max-width: 1020px) {
		.feat-grid {
			grid-template-columns: repeat(2, 1fr);
		}
		.wall-grid {
			grid-template-columns: repeat(3, 1fr);
		}
	}
	@media (max-width: 860px) {
		.hero {
			padding-top: 100px;
		}
		.hero-meta {
			display: none;
		}
		.carousel-track {
			gap: 20px 40px;
		}
		.vcell img {
			height: 36px;
		}
		.install-grid {
			grid-template-columns: 1fr;
		}
		.giant {
			max-width: none;
		}
	}
	@media (max-width: 640px) {
		.feat-grid {
			grid-template-columns: 1fr;
		}
		.wall-grid {
			grid-template-columns: repeat(2, 1fr);
		}
		.wcell {
			padding: 28px 12px 22px;
		}
		.wcell img {
			height: 44px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		[data-reveal] {
			opacity: 1;
			transform: none;
			transition: none;
		}
	}
</style>
