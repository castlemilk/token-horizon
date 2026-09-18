<script lang="ts">
	import { ChevronLeft } from 'lucide-svelte';
	import Modal from '$lib/components/common/Modal.svelte';
	import ProviderIcon from '$lib/components/data/ProviderIcon.svelte';
	import CopyField from '$lib/components/common/CopyField.svelte';
	import { copyText } from '$lib/routing';

	export interface InstructionStep {
		body: string;
		copy: string;
	}

	/** Setup-guide dialog: ordered instruction steps (body + copyable
	 *  command/URL each), an optional primary action (fix buttons) and the
	 *  optional paste-ready agent brief. */
	let {
		open,
		onClose,
		title,
		intro = '',
		steps = [],
		actionLabel,
		onAction,
		brief,
		backLabel,
		onBack,
		vendor,
		model = ''
	}: {
		open: boolean;
		onClose: () => void;
		title: string;
		intro?: string;
		steps?: InstructionStep[];
		actionLabel?: string;
		onAction?: () => void;
		brief?: string;
		/** Back navigation (returning to the guide list inside a browser). */
		backLabel?: string;
		onBack?: () => void;
		/** Brand chip beside the title when this guide is about a vendor. */
		vendor?: string;
		model?: string;
	} = $props();

	let copied = $state(false);

	function copyBrief(text: string) {
		void copyText(text).then(() => {
			copied = true;
			setTimeout(() => (copied = false), 1500);
		});
	}
</script>

{#snippet titleChip()}
	{#if vendor}<ProviderIcon {vendor} {model} size={22} />{/if}
{/snippet}

<Modal {open} {onClose} {title} titleExtra={vendor ? titleChip : undefined}>
	{#if onBack}
		<button class="back" onclick={() => onBack()}>
			<ChevronLeft size={14} strokeWidth={2.2} />{backLabel ?? 'Back'}
		</button>
	{/if}
	{#if intro}
		<div class="dim rbody">{intro}</div>
	{/if}
	{#each steps as s}
		<div class="dim rbody" style="margin-top: 10px">{s.body}</div>
		<div style="margin-top: 6px">
			<CopyField text={s.copy} />
		</div>
	{/each}
	<div class="rrow">
		{#if actionLabel && onAction}
			<button class="btn" onclick={() => onAction()}>
				{actionLabel}
			</button>
		{/if}
		{#if brief}
			<button
				class="btn"
				title="Copy paste-ready instructions for a coding agent"
				onclick={() => copyBrief(brief ?? '')}
			>
				{copied ? 'Copied' : 'Agent brief'}
			</button>
		{/if}
	</div>
</Modal>

<style>
	.back {
		appearance: none;
		border: 0;
		background: none;
		color: var(--text-2);
		font: inherit;
		font-size: 12.5px;
		font-weight: 600;
		display: inline-flex;
		align-items: center;
		gap: 2px;
		padding: 0;
		margin-bottom: 8px;
		cursor: pointer;
	}
	.back:hover {
		color: var(--text);
	}
	.rbody {
		font-size: 12.5px;
	}
	.rrow {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 12px;
		flex-wrap: wrap;
	}
</style>
