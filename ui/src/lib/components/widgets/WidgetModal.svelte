<script lang="ts">
	import type { Snippet } from 'svelte';
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';

	/** Elegant expand target for every widget: frosted backdrop + popping card.
	 *  Backdrop click / Escape closes. Body scroll locks while open.
	 *  `pop=false` skips the card scale — the parent drives its own entrance
	 *  (GSAP shared-element choreography). `backdropFade=false` skips the
	 *  Svelte backdrop fade so GSAP can ramp dim + blur on the timeline.
	 *  Placement is tunable via --wmodal-pad / --wmodal-margin; motion is
	 *  measured, never assumed. Blur itself rides --wmodal-blur. */
	let {
		open,
		title,
		sub = '',
		onclose,
		headerExtra,
		children,
		pop = true,
		backdropFade = true
	}: {
		open: boolean;
		title: string;
		sub?: string;
		onclose: () => void;
		headerExtra?: Snippet;
		children: Snippet;
		pop?: boolean;
		backdropFade?: boolean;
	} = $props();

	const reduce =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	$effect(() => {
		if (!open) return;
		const prev = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		const onkey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onclose();
		};
		window.addEventListener('keydown', onkey);
		return () => {
			document.body.style.overflow = prev;
			window.removeEventListener('keydown', onkey);
		};
	});
</script>

{#if open}
	<div
		class="wmodal-backdrop"
		in:fade={{ duration: backdropFade ? (reduce ? 0 : 180) : 0 }}
		out:fade={{ duration: reduce ? 0 : 160 }}
		onclick={(e) => {
			if (e.target === e.currentTarget) onclose();
		}}
		role="presentation"
	>
		{#if pop}
			<div
				class="wmodal-card"
				role="dialog"
				aria-modal="true"
				aria-label={title}
				transition:scale={{ duration: reduce ? 0 : 240, start: 0.93, opacity: 0, easing: cubicOut }}
			>
				{@render card()}
			</div>
		{:else}
			<div
				class="wmodal-card"
				role="dialog"
				aria-modal="true"
				aria-label={title}
				out:fade={{ duration: reduce ? 0 : 160 }}
			>
				{@render card()}
			</div>
		{/if}
		{#snippet card()}
			<div class="wmodal-head">
				<div class="wmodal-titles">
					<div class="wmodal-title">{title}</div>
					{#if sub}<div class="wmodal-sub">{sub}</div>{/if}
				</div>
				{#if headerExtra}<div class="wmodal-extra">{@render headerExtra()}</div>{/if}
				<button class="wmodal-x" onclick={onclose} aria-label="Close {title}">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
				</button>
			</div>
			<div class="wmodal-body" data-lenis-prevent>
				{@render children()}
			</div>
		{/snippet}
	</div>
{/if}

<style>
	.wmodal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		display: flex;
		align-items: center;
		justify-content: center;
		/* Tunable placement: e.g. --wmodal-margin: 10% auto 24px (percent of
		   width, even for top/bottom) or 200px auto 24px for a top-anchored
		   command-palette feel. Choreography is measured live, never
		   assumes centering, so any margin keeps working. */
		padding: var(--wmodal-pad, 20px);
		background: light-dark(rgb(250 250 251 / 0.55), rgb(10 10 12 / 0.6));
		/* Blur rides --wmodal-blur so GSAP can ramp it on the timeline
		   (tweening backdrop-filter directly would strand the -webkit-
		   prefixed twin). */
		--wmodal-blur: 14px;
		backdrop-filter: blur(var(--wmodal-blur)) saturate(1.4);
		-webkit-backdrop-filter: blur(var(--wmodal-blur)) saturate(1.4);
	}
	.wmodal-card {
		width: min(860px, 100%);
		max-height: min(86vh, 780px);
		margin: var(--wmodal-margin, 0);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: color-mix(in srgb, var(--bg-raised) 78%, transparent);
		backdrop-filter: blur(28px) saturate(1.8);
		-webkit-backdrop-filter: blur(28px) saturate(1.8);
		border-radius: 20px;
		box-shadow:
			inset 0 0 0 1px var(--line-strong),
			0 30px 80px rgb(0 0 0 / 0.28),
			0 2px 8px rgb(0 0 0 / 0.12);
		transform-origin: center;
	}
	.wmodal-head {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 18px 18px 12px;
	}
	.wmodal-titles {
		min-width: 0;
		flex: 1;
	}
	.wmodal-title {
		font-size: 15px;
		font-weight: 700;
		letter-spacing: -0.01em;
	}
	.wmodal-sub {
		margin-top: 2px;
		font-size: 12px;
		color: var(--text-3);
	}
	.wmodal-extra {
		display: flex;
		align-items: center;
		flex: none;
	}
	.wmodal-x {
		appearance: none;
		border: 0;
		background: transparent;
		color: var(--text-2);
		width: 30px;
		height: 30px;
		border-radius: 9px;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		flex: none;
	}
	.wmodal-x:hover {
		background: var(--accent-soft);
		color: var(--text);
	}
	.wmodal-body {
		padding: 4px 18px 20px;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-gutter: stable; /* no width shift when overflow appears */
	}
	@media (max-width: 640px) {
		.wmodal-backdrop {
			padding: 12px;
			align-items: flex-end;
		}
		.wmodal-card {
			max-height: 92vh;
		}
	}
</style>
