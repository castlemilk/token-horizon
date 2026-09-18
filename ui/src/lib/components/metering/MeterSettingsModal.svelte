<script lang="ts">
	import { untrack } from 'svelte';
	import { api, type Meters } from '$lib/api';
	import { validateEndpoint } from '$lib/validation';
	import Modal from '$lib/components/common/Modal.svelte';
	import ProviderIcon from '$lib/components/data/ProviderIcon.svelte';

	/** Per-vendor meter settings: the upstream API endpoint it forwards
	 *  to. Saving registers a settings endpoint (POST /runtimes/endpoints)
	 *  paired with the daemon-fixed listen port and starts the meter.
	 *  The field opens pre-filled with the current target; only edits
	 *  validate (untouched is neutral, never an error). */
	let {
		open,
		onClose,
		vendor,
		title,
		meters,
		onSaved
	}: {
		open: boolean;
		onClose: () => void;
		vendor: string;
		title: string;
		meters: Meters | null;
		onSaved: () => void;
	} = $props();

	const key = $derived(vendor.toLowerCase());
	const live = $derived(meters?.point.find((m) => m.vendor.toLowerCase() === key));
	const catalogEntry = $derived(meters?.catalog.find((c) => c.vendor.toLowerCase() === key));
	const currentTarget = $derived(live?.target ?? catalogEntry?.target ?? null);
	/** Prefill chain: live target → saved target → runtime default. */
	const prefillTarget = $derived(currentTarget ?? catalogEntry?.default_target ?? null);
	const currentPort = $derived(
		live?.listen_port ??
			meters?.catalog.find((c) => c.vendor.toLowerCase() === key)?.listen_port ??
			null
	);

	let urlDraft = $state('');
	let touched = $state(false);
	let saving = $state(false);
	let result = $state('');

	// Fresh pre-filled draft per vendor/opening — snapshot the target
	// without subscribing (poll refreshes must never clobber typing).
	$effect(() => {
		void vendor;
		if (!open) return;
		urlDraft = untrack(() => prefillTarget) ?? '';
		touched = false;
		saving = false;
		result = '';
	});

	function sameAsCurrent(): boolean {
		const raw = urlDraft.trim();
		if (!raw || !currentTarget) return false;
		try {
			return new URL(raw).href === currentTarget;
		} catch {
			return false;
		}
	}

	/** Shape errors only (red ring + trap); "already this endpoint" is a
	 *  neutral note, untouched is neutral. */
	const shapeError = $derived(touched ? validateEndpoint(urlDraft) : null);
	const unchanged = $derived(touched && urlDraft.trim() !== '' && sameAsCurrent());
	const urlState = $derived(
		!touched || !urlDraft.trim() ? '' : shapeError ? 'error' : unchanged ? '' : 'ok'
	);

	/** Wrong endpoints trap the dialog (clear the field to leave). */
	const endpointLocked = $derived(shapeError != null);

	// Listen ports are daemon-fixed (no user editing); a custom endpoint
	// always pairs with the vendor's default listen port so the meter
	// actually starts.
	const canSave = $derived.by(() => {
		if (saving) return false;
		if (!touched || !urlDraft.trim()) return false;
		return shapeError == null && !unchanged;
	});

	async function save() {
		if (!canSave) return;
		saving = true;
		result = '';
		try {
			const r = await api.addRuntimeEndpoint(vendor, urlDraft.trim(), currentPort ?? undefined);
			result = r.meter_started ? `Meter live on :${currentPort}` : 'Endpoint saved';
			onSaved();
			onClose();
		} catch (e) {
			result = e instanceof Error ? e.message : 'Save failed';
		} finally {
			saving = false;
		}
	}
</script>

{#snippet titleChip()}
	<ProviderIcon {vendor} size={22} />
{/snippet}

<Modal {open} {onClose} title={`${title} meter`} titleExtra={titleChip} dismissible={!endpointLocked}>
	<div class="dim rbody">
		{#if currentTarget}
			Currently forwarding to <span class="mono">{currentTarget}</span>
		{:else if prefillTarget}
			No meter running — save to register this endpoint and start metering on the default port.
		{:else}
			No meter running — set an endpoint to start one.
		{/if}
	</div>
	<label class="flabel" for="msm-url">API endpoint</label>
	<input
		id="msm-url"
		class="tinput mono"
		class:error={urlState === 'error'}
		class:ok={urlState === 'ok'}
		value={urlDraft}
		oninput={(e) => {
			urlDraft = e.currentTarget.value;
			touched = true;
			result = '';
		}}
		onkeydown={(e) => {
			if (e.key === 'Enter') void save();
		}}
		placeholder={currentTarget ?? 'http://127.0.0.1:11434'}
		autocomplete="off"
		spellcheck="false"
		aria-label="Upstream API endpoint URL"
	/>
	{#if shapeError}<div class="perr">{shapeError}</div>
	{:else if unchanged}<div class="faint" style="font-size: 11.5px; margin-top: 4px;">Already this endpoint</div>{/if}
	<div class="prow2">
		<button class="btn" disabled={!canSave} onclick={() => void save()}>
			{saving ? '…' : 'Save'}
		</button>
	</div>
	{#if result}<div class="pok" class:bad={!result.startsWith('Meter live') && result !== 'Endpoint saved'}>{result}</div>{/if}
	<div class="dim rbody" style="margin-top: 10px">
		Point clients at <span class="mono">127.0.0.1:{currentPort ?? '…'}</span> —
		traffic forwards byte-identical to the endpoint above and is measured in flight.
	</div>
</Modal>

<style>
	.rbody {
		font-size: 12.5px;
	}
	.flabel {
		display: block;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-3);
		margin: 12px 0 5px;
	}
	/* tri-state rings: empty = transparent, valid = green, wrong = red */
	.tinput {
		width: 100%;
		border: 1px solid transparent;
		background: var(--bg);
		color: var(--text);
		border-radius: 8px;
		font-size: 12px;
		padding: 6px 10px;
	}
	.tinput:focus {
		outline: 2px solid var(--accent);
		outline-offset: 0;
	}
	.tinput.ok {
		border-color: var(--ok);
	}
	.tinput.ok:focus {
		outline-color: var(--ok);
	}
	.tinput.error {
		border-color: var(--bad);
		background: color-mix(in srgb, var(--bad) 7%, var(--bg));
	}
	.tinput.error:focus {
		outline-color: var(--bad);
	}
	.prow2 {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 12px;
	}
	.prow2 .btn:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.perr {
		color: var(--bad);
		font-size: 11.5px;
		font-weight: 600;
	}
	.pok {
		color: var(--ok);
		font-size: 11.5px;
		font-weight: 600;
		margin-top: 8px;
	}
	.pok.bad {
		color: var(--bad);
		font-weight: 500;
	}
</style>
