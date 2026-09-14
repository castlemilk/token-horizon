<script lang="ts">
	import type { Snippet } from 'svelte';

	/** Reusable home-screen tile. Small = cubic square, large = wide banner.
	 *  The whole tile is a button so every widget expands into a modal. */
	let {
		title,
		sub = '',
		size = 'sm',
		expandLabel = 'Expand',
		onopen,
		children,
		footer
	}: {
		title: string;
		sub?: string;
		size?: 'sm' | 'md' | 'lg';
		expandLabel?: string;
		onopen: () => void;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	function onkey(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onopen();
		}
	}
</script>

<button
	class="widget"
	class:sm={size === 'sm'}
	class:md={size === 'md'}
	class:lg={size === 'lg'}
	onclick={onopen}
	onkeydown={onkey}
	aria-label="{title} — {expandLabel}"
	title="{title} — {expandLabel}"
>
	<span class="w-head">
		<span class="w-titles">
			<span class="w-title">{title}</span>
			{#if sub}<span class="w-sub">{sub}</span>{/if}
		</span>
		<span class="w-expand" aria-hidden="true">
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>
		</span>
	</span>
	<span class="w-body">
		{@render children()}
	</span>
	{#if footer}
		<span class="w-foot">{@render footer()}</span>
	{/if}
</button>

<style>
	.widget {
		appearance: none;
		border: 0;
		cursor: pointer;
		display: flex;
		flex-direction: column;
		gap: 10px;
		width: 100%;
		text-align: left;
		font: inherit;
		color: var(--text);
		background: color-mix(in srgb, var(--bg-raised) 62%, transparent);
		backdrop-filter: blur(22px) saturate(1.6);
		-webkit-backdrop-filter: blur(22px) saturate(1.6);
		border-radius: 18px;
		padding: 16px 16px 13px;
		overflow: hidden;
		/* Same 4-part structure as the modal card (ring, top light,
		   drop, contact) at resting intensity — the morph interpolates
		   toward full modal elevation, so a shrinking card never wears a
		   full-size halo that winks out at unmount. */
		box-shadow:
			inset 0 0 0 1px var(--line),
			inset 0 1px 0 rgb(255 255 255 / 0.05),
			0 6px 18px rgb(0 0 0 / 0.07),
			0 1px 3px rgb(0 0 0 / 0.06);
		transition: transform 0.22s cubic-bezier(0.2, 0.9, 0.25, 1.2), box-shadow 0.22s ease;
	}
	.widget:hover {
		transform: translateY(-2px) scale(1.008);
		box-shadow:
			inset 0 0 0 1px var(--line-strong),
			inset 0 1px 0 rgb(255 255 255 / 0.08),
			0 10px 30px rgb(0 0 0 / 0.1),
			0 2px 6px rgb(0 0 0 / 0.08);
	}
	.widget:active {
		transform: translateY(0) scale(0.992);
	}
	.widget:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	/* small = cubic tile, centered content */
	.sm {
		aspect-ratio: 1;
		max-width: 300px;
		justify-self: center;
	}
	.sm .w-body {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	/* medium = content-sized tile, wider than tall */
	.md {
		max-width: 360px;
		justify-self: center;
	}
	.md .w-body {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	/* large = wide banner */
	.lg {
		grid-column: 1 / -1;
	}
	.lg .w-body {
		display: block;
	}
	.w-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px;
	}
	.w-titles {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}
	.w-title {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-3);
	}
	.w-sub {
		font-size: 11px;
		color: var(--text-3);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.w-expand {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 7px;
		color: var(--text-3);
		flex: none;
		opacity: 0;
		transform: scale(0.8);
		transition: opacity 0.18s ease, transform 0.18s ease, background 0.18s ease;
	}
	.widget:hover .w-expand,
	.widget:focus-visible .w-expand {
		opacity: 1;
		transform: scale(1);
	}
	.w-expand:hover {
		background: var(--accent-soft);
	}
	.w-body {
		min-height: 0;
	}
	.w-foot {
		display: block;
		font-size: 10.5px;
		color: var(--text-3);
	}
	@media (prefers-reduced-motion: reduce) {
		.widget,
		.w-expand {
			transition: none;
		}
		.widget:hover {
			transform: none;
		}
	}
</style>
