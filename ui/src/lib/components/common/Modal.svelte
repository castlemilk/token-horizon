<script lang="ts">
	import type { Snippet } from 'svelte';
	import { fade, scale } from 'svelte/transition';
	import { X } from 'lucide-svelte';

	/** Centered dialog shell: scrim + Escape + body scroll-lock. Content
	 *  comes from the caller; this owns nothing but chrome. */
	let {
		open,
		onClose,
		title,
		dismissible = true,
		children
	}: {
		open: boolean;
		onClose: () => void;
		title: string;
		/** False traps the dialog (scrim/Escape/X ignored) until the
		 *  caller re-enables it — e.g. an invalid field to fix or clear. */
		dismissible?: boolean;
		children: Snippet;
	} = $props();

	const reduce =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	let closeBtn = $state<HTMLButtonElement | null>(null);

	$effect(() => {
		if (!open) return;
		const can = dismissible;
		closeBtn?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && can) onClose();
		};
		window.addEventListener('keydown', onKey);
		const prev = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			window.removeEventListener('keydown', onKey);
			document.body.style.overflow = prev;
		};
	});
</script>

{#if open}
	<!-- presentational scrim: mouse-only dismissal, keyboard path is Escape -->
	<div
		class="mback"
		role="presentation"
		onclick={(e) => {
			if (dismissible && e.target === e.currentTarget) onClose();
		}}
		transition:fade={{ duration: reduce ? 0 : 150 }}
	>
		<div
			class="mbox card"
			role="dialog"
			aria-modal="true"
			aria-label={title}
			transition:scale={{ duration: reduce ? 0 : 160, start: 0.96 }}
		>
			<div class="mhead">
				<span class="mtitle">{title}</span>
				<button
					bind:this={closeBtn}
					class="mx"
					class:locked={!dismissible}
					disabled={!dismissible}
					title={dismissible ? 'Close dialog' : 'Fix or clear the field to close'}
					onclick={onClose}
					aria-label="Close dialog"
				>
					<X size={15} strokeWidth={2.2} />
				</button>
			</div>
			{@render children()}
		</div>
	</div>
{/if}

<style>
	.mback {
		position: fixed;
		inset: 0;
		z-index: 300;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 20px;
		background: rgb(0 0 0 / 0.6);
		backdrop-filter: blur(3px);
		-webkit-backdrop-filter: blur(3px);
	}
	/* opaque: the shared card fill is translucent, dialogs sit solid */
	.mbox {
		width: 100%;
		max-width: 520px;
		max-height: 82svh;
		overflow-y: auto;
		background: var(--bg-raised);
		backdrop-filter: none;
		-webkit-backdrop-filter: none;
		box-shadow:
			0 24px 70px rgb(0 0 0 / 0.35),
			0 2px 8px rgb(0 0 0 / 0.2);
	}
	.mhead {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 10px;
	}
	.mtitle {
		font-size: 15px;
		font-weight: 700;
		letter-spacing: -0.01em;
	}
	.mx {
		appearance: none;
		border: 0;
		background: var(--track);
		color: var(--text-2);
		width: 28px;
		height: 28px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		flex: none;
	}
	.mx:hover {
		color: var(--text);
	}
	.mx.locked {
		opacity: 0.35;
		cursor: default;
	}
	.mx.locked:hover {
		color: var(--text-2);
	}
</style>
