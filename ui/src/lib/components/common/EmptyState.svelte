<script lang="ts">
	import type { ComponentType } from 'svelte';

	// Shared empty state: centered quiet type, optional icon + action.
	// Replaces the per-page empty-card / empty-quiet one-offs.
	let {
		title,
		body = '',
		icon = null,
		actionLabel = '',
		actionHref = '',
		onAction = null
	}: {
		title: string;
		body?: string;
		icon?: ComponentType | null;
		actionLabel?: string;
		actionHref?: string;
		onAction?: (() => void) | null;
	} = $props();
</script>

<div class="estate">
	{#if icon}
		{@const Icon = icon}
		<span class="eicon"><Icon size={28} strokeWidth={1.5} /></span>
	{/if}
	<div class="etitle">{title}</div>
	{#if body}<div class="dim ebody">{body}</div>{/if}
	{#if actionLabel && actionHref}
		<a class="btn" href={actionHref}>{actionLabel}</a>
	{:else if actionLabel && onAction}
		<button class="btn" onclick={onAction}>{actionLabel}</button>
	{/if}
</div>

<style>
	.estate {
		text-align: center;
		padding: 48px 24px;
		display: grid;
		gap: 8px;
		justify-items: center;
		color: var(--text-3);
	}
	.eicon {
		margin-bottom: 2px;
	}
	.etitle {
		font-size: 17px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text);
	}
	.ebody {
		font-size: 13px;
		max-width: 380px;
	}
	.estate .btn {
		margin-top: 6px;
	}
</style>
