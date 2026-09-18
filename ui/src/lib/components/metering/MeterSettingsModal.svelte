<script lang="ts">
	import { api, type Meters } from '$lib/api';
	import { validateEndpoint, validatePort } from '$lib/validation';
	import Modal from '$lib/components/common/Modal.svelte';

	/** Per-vendor meter settings: loopback listen port plus the upstream
	 *  API endpoint it forwards to. A custom URL registers a settings
	 *  endpoint (POST /runtimes/endpoints) and starts the meter on the
	 *  chosen port; a port-only change keeps the current target
	 *  (POST /meters/port). Either way the daemon persists it. */
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
	const currentTarget = $derived(
		live?.target ??
			meters?.catalog.find((c) => c.vendor.toLowerCase() === key)?.target ??
			null
	);
	const currentPort = $derived(
		live?.listen_port ??
			meters?.catalog.find((c) => c.vendor.toLowerCase() === key)?.listen_port ??
			null
	);

	let portDraft = $state('');
	let urlDraft = $state('');
	let saving = $state(false);
	let result = $state('');

	// Fresh drafts per vendor/opening — never leak one vendor's edit.
	$effect(() => {
		void vendor;
		if (!open) return;
		portDraft = '';
		urlDraft = '';
		saving = false;
		result = '';
	});

	function portError(): string | null {
		const raw = portDraft.trim();
		if (!raw) return null; // untouched — endpoint-only save
		if (Number(raw) === currentPort) return 'Already on this port';
		return validatePort(portDraft);
	}

	function urlError(): string | null {
		const raw = urlDraft.trim();
		if (!raw) return null; // untouched — port-only save
		if (currentTarget) {
			try {
				if (new URL(raw).href === currentTarget) return 'Already this endpoint';
			} catch {
				/* shape error below */
			}
		}
		return validateEndpoint(urlDraft);
	}

	/** Wrong endpoints trap the dialog (clear the field to leave); empty
	 *  is neutral, valid is green — see the tri-state input rings. */
	const endpointLocked = $derived(urlDraft.trim() !== '' && urlError() != null);
	const urlState = $derived(!urlDraft.trim() ? '' : urlError() ? 'error' : 'ok');
	const portState = $derived(!portDraft.trim() ? '' : portError() ? 'error' : 'ok');

	const canSave = $derived.by(() => {
		if (saving) return false;
		const p = portDraft.trim();
		const u = urlDraft.trim();
		if (!p && !u) return false; // nothing changed
		return portError() == null && urlError() == null;
	});

	async function save() {
		if (!canSave) return;
		saving = true;
		result = '';
		try {
			const url = urlDraft.trim();
			if (url) {
				const port = portDraft.trim() ? Number(portDraft.trim()) : undefined;
				const r = await api.addRuntimeEndpoint(vendor, url, port);
				result = r.meter_started ? `Meter live on :${port ?? currentPort}` : 'Endpoint saved';
			} else {
				const r = await api.setMeterPort(vendor, Number(portDraft.trim()));
				result = r.listen_port != null ? `Meter live on :${r.listen_port}` : 'Saved';
			}
			onSaved();
			onClose();
		} catch (e) {
			result = e instanceof Error ? e.message : 'Save failed';
		} finally {
			saving = false;
		}
	}
</script>

<Modal {open} {onClose} title={`${title} meter`} dismissible={!endpointLocked}>
	<div class="dim rbody">
		{#if currentTarget}
			Currently forwarding to <span class="mono">{currentTarget}</span>
		{:else}
			No meter running — set an endpoint and port to start one.
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
			result = '';
		}}
		placeholder={currentTarget ?? 'http://127.0.0.1:11434'}
		autocomplete="off"
		spellcheck="false"
		aria-label="Upstream API endpoint URL"
	/>
	{#if urlError()}<div class="perr">{urlError()}</div>{/if}
	<label class="flabel" for="msm-port">Meter listen port</label>
	<div class="prow2">
		<input
			id="msm-port"
			class="tinput mono port"
			class:error={portState === 'error'}
			class:ok={portState === 'ok'}
			value={portDraft}
			oninput={(e) => {
				const clean = e.currentTarget.value.replace(/\D+/g, '').slice(0, 5);
				if (clean !== e.currentTarget.value) e.currentTarget.value = clean;
				portDraft = clean;
				result = '';
			}}
			onkeydown={(e) => {
				if (e.key === 'Enter') void save();
			}}
			placeholder={currentPort != null ? String(currentPort) : ''}
			inputmode="numeric"
			pattern="[0-9]*"
			autocomplete="off"
			spellcheck="false"
			maxlength={5}
			aria-label="Meter listen port"
		/>
		<button class="btn" disabled={!canSave} onclick={() => void save()}>
			{saving ? '…' : 'Save'}
		</button>
		{#if portError()}<span class="perr">{portError()}</span>{/if}
	</div>
	{#if result}<div class="pok" class:bad={!result.startsWith('Meter live') && result !== 'Endpoint saved' && result !== 'Saved'}>{result}</div>{/if}
	<div class="dim rbody" style="margin-top: 10px">
		Point clients at <span class="mono">127.0.0.1:{portDraft.trim() || (currentPort ?? '…')}</span> —
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
	.tinput.port {
		width: 96px;
		flex: none;
		font-variant-numeric: tabular-nums;
	}
	.prow2 {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
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
