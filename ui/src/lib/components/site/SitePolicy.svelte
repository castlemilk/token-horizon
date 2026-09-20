<script lang="ts">
	// Shared shell for the legal pages: Palantir-style policy surface —
	// breadcrumb, oversized display title, hairline rules, hairline-divided
	// numbered sections, and a prev/next legal nav. Slotted content is
	// styled via :global below (Svelte scoped styles don't reach into slots).
	let { title, updated, children } = $props();
</script>

<svelte:head>
	<title>{title} · Token Horizon</title>
</svelte:head>

<main class="policy" id="main">
	<nav class="crumbs" aria-label="Breadcrumb">
		<a href="/">Token Horizon</a><span aria-hidden="true">/</span>
		<a href="/terms">Legal</a><span aria-hidden="true">/</span>
		<span aria-current="page">{title}</span>
	</nav>
	<span class="kicker">Legal</span>
	<h1>{title}</h1>
	<p class="updated">Last updated · {updated}</p>
	{@render children()}
	<nav class="legal-nav" aria-label="More legal documents">
		<a href="/terms">Terms</a><span aria-hidden="true">·</span>
		<a href="/privacy">Privacy</a><span aria-hidden="true">·</span>
		<a href="/eula">EULA</a>
	</nav>
</main>

<style>
	.policy {
		max-width: 720px;
		margin: 0 auto;
		padding: 160px var(--page-pad-x) 100px;
	}
	.crumbs {
		display: flex;
		gap: 10px;
		align-items: center;
		flex-wrap: wrap;
		font-size: 0.8125rem;
		color: var(--text-muted);
		margin-bottom: 40px;
	}
	.crumbs a {
		color: var(--text-muted);
		text-decoration: none;
	}
	.crumbs a:hover {
		color: var(--text-inverse);
		text-decoration: underline;
		text-underline-offset: 4px;
	}
	.crumbs [aria-current='page'] {
		color: var(--text-inverse);
	}
	.kicker {
		display: block;
		font-size: 0.625rem;
		line-height: 1.6;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-muted);
		margin-bottom: 14px;
	}
	.kicker::before {
		content: '// ';
	}
	.policy h1 {
		font: 400 clamp(2rem, 5vw, 3.5rem) / 1.05 var(--font-display);
		letter-spacing: -0.02em;
		margin: 0 0 14px;
	}
	.updated {
		color: var(--text-muted);
		margin: 0 0 40px;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		padding-bottom: 40px;
		border-bottom: 1px solid var(--border);
	}

	:global(.policy h2) {
		font-size: 1.125rem;
		font-weight: 400;
		margin: 0;
		padding: 28px 0 10px;
		border-top: 1px solid var(--border);
	}
	:global(.policy h2::before) {
		content: '↳ ';
		color: var(--text-muted);
	}
	:global(.policy p),
	:global(.policy li) {
		line-height: 1.6;
		margin: 0 0 14px;
	}
	:global(.policy ul) {
		padding-left: 20px;
		margin: 0 0 14px;
	}
	:global(.policy a) {
		color: var(--text-inverse);
		text-decoration: underline;
		text-underline-offset: 4px;
	}
	.legal-nav {
		display: flex;
		gap: 14px;
		align-items: center;
		margin-top: 60px;
		padding-top: 24px;
		border-top: 1px solid var(--border);
		color: var(--text-muted);
	}
	.legal-nav a {
		color: var(--text-muted);
		text-decoration: none;
	}
	.legal-nav a:hover {
		color: var(--text-inverse);
		text-decoration: underline;
		text-underline-offset: 4px;
	}
</style>
