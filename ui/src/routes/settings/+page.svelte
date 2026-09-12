<script lang="ts">
	import { onMount } from 'svelte';
	import { api, type ServiceStatus, type ConsentState } from '$lib/api';
	import { getTheme, setTheme, type Theme } from '$lib/theme';
	import { settings } from '$lib/settings.svelte';
	import { Sun, Moon, Monitor } from 'lucide-svelte';
	import { Switch } from '$lib/components/ui/switch/index.js';

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
	let saved = $state(false);
	let consolidating = $state(false);
	let consolidateResult = $state<string | null>(null);
	let consents = $state<ConsentState[]>([]);

	const CONSENT_COPY: Record<string, { title: string; body: string }> = {
		metering: {
			title: 'Measure requests',
			body: 'Loopback relays observe per-request token usage.'
		},
		fileReading: {
			title: 'Read tool session files',
			body: 'Joins tool labels and reported costs onto metered requests.'
		},
		telemetry: {
			title: 'Watch local runtimes',
			body: 'Detects local models and scrapes speed counters.'
		}
	};

	async function loadConsents() {
		try {
			consents = (await api.consents())?.scopes ?? [];
		} catch {
			/* daemon down — toggles stay hidden */
		}
	}

	async function flipConsent(scope: string, granted: boolean) {
		try {
			await api.setConsent(scope, granted);
			await loadConsents();
		} catch {
			/* daemon down */
		}
	}

	function replayOnboarding() {
		try {
			localStorage.removeItem('token-horizon.onboarded');
		} catch {
			/* private mode */
		}
		location.reload();
	}

	// Daemon boot registration — served by the daemon itself, so this works
	// in the browser too (unlike the Tauri-plugin app autostart above).
	let service = $state<ServiceStatus | null>(null);
	let serviceBusy = $state(false);
	let serviceError = $state<string | null>(null);

	async function loadService() {
		try {
			service = await api.serviceStatus();
		} catch {
			service = null;
		}
	}

	async function toggleService() {
		if (!service || serviceBusy) return;
		serviceBusy = true;
		serviceError = null;
		try {
			service = service.enabled ? await api.uninstallService() : await api.installService();
		} catch (e) {
			serviceError = e instanceof Error ? e.message : 'service operation failed';
			await loadService();
		} finally {
			serviceBusy = false;
		}
	}

	async function consolidateNow() {
		consolidating = true;
		consolidateResult = null;
		try {
			const r = await api.consolidate();
			const parts = Object.entries(r.observations)
				.filter(([, n]) => n > 0)
				.map(([v, n]) => `${v}: ${n}`);
			consolidateResult = parts.length > 0 ? `Joined ${parts.join(' · ')}` : 'No new file observations';
		} catch (e) {
			consolidateResult = e instanceof Error && e.message.includes('403')
				? 'File-reading consent not granted on the daemon'
				: 'Consolidation failed — daemon unreachable';
		} finally {
			consolidating = false;
		}
	}

	onMount(() => {
		theme = getTheme();
		void loadAutostart();
		void loadService();
		void loadConsents();
	});

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
		{#each [
			{ id: 'system', label: 'Auto · follows the OS', icon: Monitor },
			{ id: 'light', label: 'Light', icon: Sun },
			{ id: 'dark', label: 'Dark', icon: Moon }
		] as t}
			<button
				class:active={theme === t.id}
				title={t.label}
				aria-label={t.label}
				onclick={() => pickTheme(t.id as Theme)}
			>
				<t.icon size={15} strokeWidth={1.8} />
			</button>
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
	<div class="toggle-row">
		<span class="tname">Daemon starts with the machine</span>
		<span class="hint" style="margin: 0">
			{service?.supported
				? (service.detail || 'Registers the daemon with the OS service manager')
				: 'Not supported on this platform'}
		</span>
		<button
			class="switch"
			class:on={service?.enabled === true}
			role="switch"
			aria-checked={service?.enabled === true}
			aria-label="Daemon starts with the machine"
			disabled={!service?.supported || serviceBusy}
			onclick={() => void toggleService()}
		></button>
	</div>
	{#if serviceError}
		<div class="hint" style="margin-top: 6px; color: var(--red, #e5534b)">{serviceError}</div>
	{/if}
	<div class="hint" style="margin-top: 6px">
		Closing the window hides the app to the system tray — request logging and sync keep running.
		Quit from the tray menu to stop everything.
	</div>
</div>

<div class="section-label">Permissions</div>
<div class="card">
	{#if consents.length === 0}
		<div class="empty">Daemon unreachable — permissions load when the listener is up</div>
	{:else}
		{#each Object.keys(CONSENT_COPY) as scope}
			{@const rec = consents.find((c) => c.scope === scope)}
			<div class="toggle-row">
				<span class="tname">{CONSENT_COPY[scope].title}</span>
				<span class="hint" style="margin: 0">{CONSENT_COPY[scope].body}</span>
				{#if rec}
					<Switch
						checked={rec.granted}
						onCheckedChange={(v) => void flipConsent(scope, v)}
						aria-label={CONSENT_COPY[scope].title}
					/>
				{/if}
			</div>
		{/each}
	{/if}
	<div class="toggle-row">
		<span class="tname">Replay onboarding</span>
		<span class="hint" style="margin: 0">Walk through setup, permissions, and client routing again</span>
		<button class="btn" onclick={replayOnboarding}>Replay</button>
	</div>
</div>

<div class="section-label">Data</div>
<div class="card">
	<div class="toggle-row">
		<span class="tname">File imports in dashboards</span>
		<span class="hint" style="margin: 0">
			Show file-imported (self-reported, non-metered) history — debugging view, off for prod
		</span>
		<button
			class="switch"
			class:on={settings.showImports}
			role="switch"
			aria-checked={settings.showImports}
			aria-label="File imports in dashboards"
			onclick={() => { settings.showImports = !settings.showImports; settings.save(); }}
		></button>
	</div>
	<div class="toggle-row">
		<span class="tname">Consolidate files</span>
		<span class="hint" style="margin: 0">
			{consolidateResult ?? 'One pass over tool session files — joins tool labels and file-claimed costs onto metered requests'}
		</span>
		<button class="btn" disabled={consolidating} onclick={() => void consolidateNow()}
			>{consolidating ? 'Scanning…' : 'Run'}</button>
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
		border-radius: 10px;
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
		padding: 10px 0;
		border-bottom: 1px solid var(--line);
	}
	@media (min-width: 1100px) {
		.toggle-row {
			padding: 12px 0;
		}
	}
	.toggle-row:last-of-type {
		border-bottom: none;
	}
	.tname {
		font-size: 13px;
		font-weight: 500;
	}
</style>
