<script lang="ts">
	import { onMount } from 'svelte';
	import { api, apiBase, setApiBase, type ProviderSummary, type RuntimeInfo, type ProviderLimit } from '$lib/api';
	import { getTheme, setTheme, type Theme } from '$lib/theme';
	import { settings } from '$lib/settings.svelte';
	import { providerAccent } from '$lib/colors';
	import { poll } from '$lib/format';

	// Autostart is a Tauri plugin — only callable inside the desktop shell.
	const inTauri = typeof window !== 'undefined' && '__TAURI__' in window;
	let autostart = $state<boolean | null>(null);

	type AutostartPlugin = typeof import('@tauri-apps/plugin-autostart');
	const autostartPlugin = $state<{ current: AutostartPlugin | null }>({ current: null });

	async function loadAutostart() {
		if (!inTauri) return;
		try {
			const p = await import('@tauri-apps/plugin-autostart');
			autostartPlugin.current = p;
			autostart = await p.isEnabled();
		} catch {
			autostart = null;
		}
	}

	async function toggleAutostart() {
		const p = autostartPlugin.current;
		if (!p) return;
		if (autostart) await p.disable();
		else await p.enable();
		autostart = await p.isEnabled();
	}

	let theme = $state<Theme>('system');
	let base = $state('');
	let summary = $state<ProviderSummary[]>([]);
	let runtimes = $state<RuntimeInfo[]>([]);
	let limits = $state<ProviderLimit[]>([]);
	let saved = $state(false);

	onMount(() => {
		theme = getTheme();
		base = apiBase();
		void loadAutostart();
		return poll(async () => {
			try {
				[summary, runtimes, limits] = await Promise.all([
					api.summary().then((r) => r.providers),
					api.runtimes(),
					api.limits().then((r) => r.limits)
				]);
			} catch {
				/* daemon down */
			}
		}, 15000);
	});

	// Providers the machine has discovered: metered traffic ∪ quota adapters.
	const discoveredProviders = $derived(
		[...new Set([...summary.map((p) => p.vendor), ...limits.map((l) => l.provider)])].sort()
	);

	function pickTheme(t: Theme) {
		theme = t;
		setTheme(t);
	}

	function saveAccount() {
		settings.handle = settings.handle.trim() || 'me';
		settings.save();
		saved = true;
		setTimeout(() => (saved = false), 1500);
	}

	function applyBase() {
		const v = base.trim();
		setApiBase(v && v !== 'http://127.0.0.1:8765' ? v : null);
		location.reload();
	}
</script>

<div class="section-label">Account</div>
<div class="card">
	<div class="field">
		<label for="handle">Handle</label>
		<div class="row">
			<span class="at">@</span>
			<input id="handle" class="input" bind:value={settings.handle} spellcheck="false" />
			<button class="btn" onclick={saveAccount}>{saved ? 'Saved' : 'Save'}</button>
			<a class="btn" href="/@{settings.handle.trim() || 'me'}">View profile</a>
		</div>
		<div class="hint">Your local identity — used on the profile page and, later, leaderboard publishing.</div>
	</div>
</div>

<div class="section-label">Appearance</div>
<div class="card">
	<div class="seg" role="group" aria-label="Theme">
		{#each [['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']] as [id, label]}
			<button class:active={theme === id} onclick={() => pickTheme(id as Theme)}>{label}</button>
		{/each}
	</div>
	<div class="hint" style="margin-top: 8px">Auto follows the OS. Accent follows the OS accent color where supported.</div>
</div>

<div class="section-label">Startup & background</div>
<div class="card">
	<div class="toggle-row">
		<span class="tname">Start on boot</span>
		<span class="hint" style="margin: 0">
			{inTauri ? 'Launches into the tray at login; logging starts with the machine' : 'Only available in the desktop app'}
		</span>
		<button
			class="switch"
			class:on={autostart === true}
			role="switch"
			aria-checked={autostart === true}
			aria-label="Start on boot"
			disabled={!inTauri || autostart === null}
			onclick={() => void toggleAutostart()}
		></button>
	</div>
	<div class="hint" style="margin-top: 6px">
		Closing the window hides Token Horizon to the system tray — request logging and sync keep running.
		Quit from the tray menu to stop everything.
	</div>
</div>

<div class="section-label">Connection</div>
<div class="card">
	<div class="field">
		<label for="api">Loopback API</label>
		<div class="row">
			<input id="api" class="input mono" bind:value={base} spellcheck="false" />
			<button class="btn" onclick={applyBase}>Apply</button>
		</div>
		<div class="hint">Default http://127.0.0.1:8765. Point at a remote daemon to watch another machine.</div>
	</div>
</div>

<div class="section-label">Logging · Providers ({discoveredProviders.filter((p) => settings.providerEnabled(p)).length}/{discoveredProviders.length})</div>
<div class="card">
	{#if discoveredProviders.length === 0}
		<div class="empty">No providers discovered yet — they appear as the machine detects traffic and quota adapters</div>
	{:else}
		{#each discoveredProviders as v}
			<div class="toggle-row">
				<span class="swatch" style:background={providerAccent(v)}></span>
				<span class="tname">{v}</span>
				<button
					class="switch"
					class:on={settings.providerEnabled(v)}
					role="switch"
					aria-checked={settings.providerEnabled(v)}
					aria-label="Log {v}"
					onclick={() => settings.toggleProvider(v)}
				></button>
			</div>
		{/each}
	{/if}
</div>

<div class="section-label">Logging · Runtimes ({runtimes.filter((r) => settings.runtimeEnabled(r.vendor)).length}/{runtimes.length})</div>
<div class="card">
	{#if runtimes.length === 0}
		<div class="empty">No runtimes discovered yet</div>
	{:else}
		{#each runtimes as rt}
			<div class="toggle-row">
				<span class="swatch" style:background={providerAccent(rt.vendor)}></span>
				<span class="tname">{rt.display_name}</span>
				<span class="hint" style="margin: 0">{rt.running ? 'running' : 'not running'}</span>
				<button
					class="switch"
					class:on={settings.runtimeEnabled(rt.vendor)}
					role="switch"
					aria-checked={settings.runtimeEnabled(rt.vendor)}
					aria-label="Log {rt.display_name}"
					onclick={() => settings.toggleRuntime(rt.vendor)}
				></button>
			</div>
		{/each}
	{/if}
	<div class="hint" style="margin-top: 10px">
		Toggles currently filter what this app displays. Daemon-side collection control is wired to these preferences in a future release.
	</div>
</div>

<style>
	.field label {
		display: block;
		font-size: 12px;
		font-weight: 600;
		color: var(--text-2);
		margin-bottom: 5px;
	}
	.input {
		flex: 1;
		min-width: 0;
		border: 1px solid var(--line);
		background: var(--bg);
		color: var(--text);
		border-radius: var(--radius);
		font-family: inherit;
		font-size: 13px;
		padding: 5px 10px;
	}
	.input:focus {
		outline: 2px solid var(--accent);
		outline-offset: 0;
		border-color: transparent;
	}
	.at {
		color: var(--text-3);
		font-weight: 600;
	}
	.hint {
		font-size: 11.5px;
		color: var(--text-3);
		margin-top: 6px;
	}
	.toggle-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 7px 0;
		border-bottom: 1px solid var(--line);
	}
	.toggle-row:last-of-type {
		border-bottom: none;
	}
	.tname {
		font-size: 13px;
		font-weight: 500;
	}
	.swatch {
		width: 8px;
		height: 8px;
		border-radius: 2.5px;
		flex: none;
	}
	/* Hairline switch */
	.switch {
		margin-left: auto;
		appearance: none;
		width: 32px;
		height: 18px;
		border-radius: 999px;
		border: 1px solid var(--line-strong);
		background: var(--track);
		position: relative;
		cursor: pointer;
		transition: background 0.15s, border-color 0.15s;
		flex: none;
	}
	.switch::after {
		content: '';
		position: absolute;
		top: 2px;
		left: 2px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--text-3);
		transition: transform 0.15s, background 0.15s;
	}
	.switch.on {
		background: var(--accent);
		border-color: var(--accent);
	}
	.switch.on::after {
		transform: translateX(14px);
		background: #fff;
	}
	.switch:disabled {
		opacity: 0.45;
		cursor: default;
	}
</style>
