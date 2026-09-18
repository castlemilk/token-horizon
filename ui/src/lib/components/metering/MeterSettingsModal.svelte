<script lang="ts">
	import { api, type Meters } from '$lib/api';
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
		if (!/^\d{1,5}$/.test(raw)) return 'Digits only';
		const n = Number(raw);
		if (n < 1 || n > 65535) return 'Port must be 1–65535';
		if (n === currentPort) return 'Already on this port';
		return null;
	}

	function urlError(): string | null {
		const raw = urlDraft.trim();
		if (!raw) return null; // untouched — port-only save
		let u: URL;
		try {
			u = new URL(raw);
		} catch {
			return 'Must be a full http(s) URL';
		}
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Must be a full http(s) URL';
		if (u.href === currentTarget) return 'Already this endpoint';
		const host = u.hostname.toLowerCase();
		const hasPort = u.port !== '';
		const isLoopback =
			host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
		// Local targets are meaningless without a port — and a bare
		// single-label name is neither a local address nor a real domain.
		if (isLoopback && !hasPort)
			return 'Local endpoints need an explicit port — e.g. http://127.0.0.1:11434';
		if (!isLoopback && !hasPort && !host.includes('.'))
			return 'Use a full domain or IP, or add a port — e.g. https://api.example.com';
		return null;
	}

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

<Modal {open} {onClose} title={`${title} meter`}>
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
		class:error={urlError() != null}
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
			class:error={portError() != null}
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
	.tinput {
		width: 100%;
		border: 1px solid var(--line);
		background: var(--bg);
		color: var(--text);
		border-radius: 8px;
		font-size: 12px;
		padding: 6px 10px;
	}
	.tinput:focus {
		outline: 2px solid var(--accent);
		outline-offset: 0;
		border-color: transparent;
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
