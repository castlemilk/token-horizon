<script lang="ts">
	// Marketing-site chrome: bare nav (Leaderboard · Docs · Install) and the
	// grid footer. Rendered INSTEAD of the app island shell for the landing
	// and policy pages (see the isSite branch in the root layout). Styles
	// are scoped to this component; design tokens live on .site and inherit.
	let { children } = $props();
	let menuOpen = $state(false);
</script>

<svelte:head>
	<!-- Display type is served locally (no third-party fetch, offline-safe),
	   from the same Archivo Black cut as the 3D headline outlines. -->
</svelte:head>

<div class="site">
	<a class="skip" href="#main">Skip to content</a>

	<nav class="nav" class:open={menuOpen}>
		<button
			class="nav-toggle"
			type="button"
			aria-label="Toggle navigation"
			aria-expanded={menuOpen}
			aria-controls="nav-links"
			onclick={() => (menuOpen = !menuOpen)}
		>
			☰
		</button>
		<div class="nav-links" id="nav-links">
			<a href="/leaderboard">Leaderboard</a>
			<a href="/docs/">Docs</a>
			<a class="nav-cta" href="/#install">Install</a>
		</div>
	</nav>

	{@render children()}

	<footer class="footer">
		<div class="footer-grid">
			<div class="footer-brand">
				<a class="brand" href="/"><img src="/assets/icon.png" alt="" /><span>Token Horizon</span></a>
				<p class="footer-copy">Native observability for AI-powered machines.</p>
			</div>
			<div class="footer-col">
				<span class="flabel">Product</span>
				<a href="/#features">Coverage</a>
				<a href="/leaderboard">Leaderboard</a>
				<a href="/models/">Models</a>
				<a href="/#install">Install</a>
			</div>
			<div class="footer-col">
				<span class="flabel">Resources</span>
				<a href="/docs/">Docs</a>
				<a href="/blog/">Blog</a>
			</div>
			<div class="footer-col">
				<span class="flabel">Legal</span>
				<a href="/terms">Terms</a>
				<a href="/privacy">Privacy</a>
				<a href="/eula">EULA</a>
			</div>
		</div>
		<div class="footer-legal">
			<span>© 2026 Token Horizon.</span>
		</div>
	</footer>
</div>

<style>
	@font-face {
		font-family: 'Archivo Black';
		src: url('/fonts/ArchivoBlack-Regular.ttf') format('truetype');
		font-weight: 400;
		font-style: normal;
		font-display: swap;
	}
	.site {
		/* Locked near-black palette: identical in light AND dark mode.
		   color-scheme: dark pins form controls/scrollbars so the OS
		   light mode can't re-tint the landing page. No light-dark()
		   tokens may live under .site — every new color must be a
		   literal hex for the same reason. */
		color-scheme: dark;
		--ink-deep: #08080a;
		--ink: #f2f2f3;
		--canvas: #08080a;
		--text-inverse: #f5f5f6;
		--text-muted: #8e8e96;
		--border: #26262b;
		--border-light: #333338;
		--hairline: #1c1c20;
		--gap: 30px;
		--page-pad-x: 30px;
		--font-body: 'Helvetica Neue', Arial, sans-serif;
		/* Monumental grotesk display; system fallbacks keep it offline. */
		--font-display: 'Archivo Black', 'Arial Black', 'Helvetica Neue', sans-serif;
		--font-hero: 'Archivo Black', 'Arial Black', 'Helvetica Neue', sans-serif;
		--font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		--signal: #e8ecf3;

		min-height: 100vh;
		background: var(--ink-deep);
		color: var(--text-inverse);
		font: 400 1rem/1.429 var(--font-body);
		-webkit-font-smoothing: antialiased;
	}
	.site ::selection {
		background: var(--signal);
		color: var(--canvas);
	}

	.skip {
		position: absolute;
		left: var(--page-pad-x);
		top: -60px;
		padding: 10px 14px;
		background: var(--canvas);
		color: var(--ink);
		text-decoration: none;
		z-index: 100;
	}
	.skip:focus {
		top: 10px;
	}

	.nav {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--gap);
		padding: 0 var(--page-pad-x);
		height: 64px;
		background: color-mix(in srgb, var(--ink-deep) 82%, transparent);
		backdrop-filter: blur(18px) saturate(1.4);
		-webkit-backdrop-filter: blur(18px) saturate(1.4);
		border-bottom: 1px solid var(--border);
	}
	.nav-links {
		display: flex;
		gap: 26px;
		align-items: center;
	}
	.nav-links a {
		font-size: 0.875rem;
		line-height: 1.4;
		color: var(--text-muted);
		text-decoration: none;
		transition: color 0.15s;
	}
	.nav-links a:hover {
		color: var(--text-inverse);
		text-decoration: underline;
		text-underline-offset: 4px;
	}
	.nav-links a:focus-visible {
		outline: 2px solid var(--text-inverse);
		outline-offset: 3px;
	}
	/* Sharp rectangular CTA — the Palantir "Request a demo" slot. */
	.nav-links a.nav-cta {
		color: var(--ink-deep);
		background: var(--text-inverse);
		padding: 9px 20px;
		font-weight: 600;
	}
	.nav-links a.nav-cta:hover {
		color: var(--ink-deep);
		background: #fff;
		text-decoration: none;
	}
	.nav-toggle {
		display: none;
	}

	.footer {
		padding: 90px var(--page-pad-x) 40px;
		overflow: hidden;
	}
	.footer-grid {
		max-width: 1000px;
		margin: 0 auto;
		display: grid;
		grid-template-columns: 2fr 1fr 1fr 1fr;
		gap: 60px;
	}
	.footer-brand {
		display: flex;
		flex-direction: column;
		gap: 14px;
		align-items: flex-start;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 12px;
		text-decoration: none;
	}
	.brand img {
		width: 24px;
		height: 24px;
		border-radius: 2px;
	}
	.brand span {
		font-size: 1.125rem;
		letter-spacing: -0.01em;
	}
	.footer-copy {
		color: var(--text-muted);
		margin: 0;
		max-width: 280px;
	}
	.footer-legal {
		max-width: 1000px;
		margin: 70px auto 0;
		padding: 0;
		display: flex;
		align-items: center;
		gap: 18px;
		flex-wrap: wrap;
		font-size: 0.8125rem;
		color: var(--text-muted);
	}
	.footer-col {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding-left: 0;
	}
	.footer-col a {
		color: var(--text-inverse);
		text-decoration: none;
	}
	.footer-col a:hover {
		text-decoration: underline;
		text-underline-offset: 4px;
	}
	.flabel {
		font-size: 0.625rem;
		line-height: 1.6;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-muted);
		margin-bottom: 6px;
	}
	@media (max-width: 860px) {
		.nav {
			height: 58px;
		}
		.nav-toggle {
			display: inline-grid;
			place-items: center;
			background: none;
			border: 1px solid var(--border-light);
			color: var(--text-inverse);
			width: 40px;
			height: 36px;
			font-size: 16px;
			cursor: pointer;
		}
		.nav-links {
			display: none;
			position: absolute;
			top: 100%;
			left: 0;
			right: 0;
			flex-direction: column;
			align-items: flex-start;
			gap: 0;
			background: var(--ink-deep);
			border-bottom: 1px solid var(--border);
			padding: 10px var(--page-pad-x) 20px;
		}
		.nav.open .nav-links {
			display: flex;
		}
		.nav-links a {
			padding: 12px 0;
		}
		.nav-links a.nav-cta {
			margin-top: 8px;
			padding: 12px 20px;
		}
		.footer-grid {
			grid-template-columns: 1fr;
			gap: 50px;
		}
		.footer-col {
			padding-top: 0;
		}
	}
</style>
