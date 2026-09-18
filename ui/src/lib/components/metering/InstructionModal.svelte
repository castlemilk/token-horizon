<script lang="ts">
	import Modal from '$lib/components/common/Modal.svelte';
	import CopyField from '$lib/components/common/CopyField.svelte';
	import { copyText } from '$lib/routing';

	export interface InstructionStep {
		body: string;
		copy: string;
	}

	/** Setup-guide dialog: ordered instruction steps (body + copyable
	 *  command/URL each) plus the paste-ready agent brief. */
	let {
		open,
		onClose,
		title,
		intro = '',
		steps,
		brief
	}: {
		open: boolean;
		onClose: () => void;
		title: string;
		intro?: string;
		steps: InstructionStep[];
		brief: string;
	} = $props();

	let copied = $state(false);

	function copyBrief() {
		void copyText(brief).then(() => {
			copied = true;
			setTimeout(() => (copied = false), 1500);
		});
	}
</script>

<Modal {open} {onClose} {title}>
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
		<button
			class="btn"
			title="Copy paste-ready instructions for a coding agent"
			onclick={copyBrief}
		>
			{copied ? 'Copied' : 'Agent brief'}
		</button>
	</div>
</Modal>

<style>
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
