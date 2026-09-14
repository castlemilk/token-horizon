<script lang="ts">
	import { copyText } from '$lib/routing';

	// Shared copy field: mono block + Copy button with its own copied flash.
	// Replaces the per-page cmd/copy duos (machine recovery, onboarding).
	let { text, label = 'Copy' }: { text: string; label?: string } = $props();

	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;

	function copy() {
		void copyText(text).then((ok) => {
			if (!ok) return;
			copied = true;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => (copied = false), 1500);
		});
	}
</script>

<div class="cfield">
	<code class="cmd">{text}</code>
	<button class="btn" onclick={copy}>{copied ? 'Copied' : label}</button>
</div>

<style>
	.cfield {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 10px;
		flex-wrap: wrap;
	}
	.cmd {
		display: block;
		box-sizing: border-box;
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.5;
		color: var(--text-2);
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 8px;
		box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.06);
		padding: 6px 10px;
		overflow-x: auto;
		white-space: nowrap;
		flex: 1;
		min-width: 0;
	}
</style>
