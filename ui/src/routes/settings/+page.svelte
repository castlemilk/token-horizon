<script lang="ts">
	import { onMount } from 'svelte';
	import { api, type ServiceStatus, type ConsentState } from '$lib/api';
	import {
		cloud,
		cloudBase,
		setCloudBase,
		cloudToken,
		signIn,
		type CloudUser,
		type Team,
		type Group
	} from '$lib/cloud';
	import AvatarUpload from '$lib/components/account/AvatarUpload.svelte';
	import { copyText } from '$lib/routing';
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

	/* ---- Cloud identity (Go server) ---- */
	let cloudUser = $state<CloudUser | null>(null);
	let cloudBaseUrl = $state(cloudBase());
	let cloudBusy = $state(false);
	let cloudError = $state<string | null>(null);
	let loginBusy = $state<null | 'google' | 'microsoft'>(null);
	let loginState = $state('');
	let copied = $state<string | null>(null);

	let displayName = $state('');
	let accountMsg = $state('');

	let teams = $state<Team[]>([]);
	let groupsByTeam = $state<Record<string, Group[]>>({});
	let newTeamName = $state('');
	let joinCode = $state('');
	let newGroupName = $state<Record<string, string>>({});
	let joinGroupCode = $state('');
	let teamsMsg = $state('');

	function copy(text: string, key: string) {
		void copyText(text).then((ok) => {
			if (ok) {
				copied = key;
				setTimeout(() => (copied = null), 1500);
			}
		});
	}

	async function refreshCloudUser() {
		try {
			cloudUser = await cloud.me();
			displayName = cloudUser.display_name ?? '';
		} catch {
			cloudUser = null;
		}
	}

	async function saveCloudBase() {
		setCloudBase(cloudBaseUrl.trim() || null);
		cloudBusy = true;
		cloudError = null;
		try {
			await refreshCloudUser();
			if (!cloudToken()) cloudError = 'Saved — sign in below';
		} finally {
			cloudBusy = false;
		}
	}

	async function doLogin(provider: 'google' | 'microsoft') {
		loginBusy = provider;
		loginState = '';
		cloudError = null;
		try {
			const r = await signIn(provider, (s) => {
				loginState = s === 'opening' ? 'Opening browser…' : 'Waiting in the browser…';
			});
			cloudUser = r.user;
			displayName = r.user.display_name ?? '';
			void loadTeams();
		} catch (e) {
			cloudError = e instanceof Error ? e.message : 'Sign-in failed';
		} finally {
			loginBusy = null;
			loginState = '';
		}
	}

	async function doLogout() {
		await cloud.logout().catch(() => {});
		cloudUser = null;
		teams = [];
		groupsByTeam = {};
	}

	async function saveAccount() {
		accountMsg = '';
		if (cloudUser) {
			try {
				cloudUser = await cloud.updateAccount({
					display_name: displayName.trim(),
					handle: settings.handle.trim() || undefined
				});
				accountMsg = 'Saved';
			} catch (e) {
				accountMsg = e instanceof Error ? e.message : 'Save failed';
			}
		} else {
			settings.handle = settings.handle.trim() || 'me';
			settings.save();
			saved = true;
			setTimeout(() => (saved = false), 1500);
		}
		setTimeout(() => (accountMsg = ''), 2500);
	}

	async function loadTeams() {
		teamsMsg = '';
		try {
			teams = (await cloud.teams()).teams;
			const g: Record<string, Group[]> = {};
			for (const t of teams) {
				try {
					g[t.id] = (await cloud.groups(t.id)).groups;
				} catch {
					g[t.id] = [];
				}
			}
			groupsByTeam = g;
		} catch (e) {
			teamsMsg = e instanceof Error ? e.message : 'Teams unavailable';
		}
	}

	async function createTeam() {
		if (!newTeamName.trim()) return;
		try {
			await cloud.createTeam(newTeamName.trim());
			newTeamName = '';
			await loadTeams();
		} catch (e) {
			teamsMsg = e instanceof Error ? e.message : 'Create failed';
		}
	}

	async function joinTeam() {
		if (!joinCode.trim()) return;
		try {
			await cloud.joinTeam(joinCode.trim());
			joinCode = '';
			await loadTeams();
		} catch (e) {
			teamsMsg = e instanceof Error ? e.message : 'Join failed';
		}
	}

	async function leaveTeam(id: string) {
		try {
			await cloud.leaveTeam(id);
			await loadTeams();
		} catch (e) {
			teamsMsg = e instanceof Error ? e.message : 'Leave failed';
		}
	}

	async function createGroup(teamID: string) {
		const name = (newGroupName[teamID] ?? '').trim();
		if (!name) return;
		try {
			await cloud.createGroup(teamID, name);
			newGroupName[teamID] = '';
			await loadTeams();
		} catch (e) {
			teamsMsg = e instanceof Error ? e.message : 'Create failed';
		}
	}

	async function joinGroup() {
		if (!joinGroupCode.trim()) return;
		try {
			await cloud.joinGroup(joinGroupCode.trim());
			joinGroupCode = '';
			await loadTeams();
		} catch (e) {
			teamsMsg = e instanceof Error ? e.message : 'Join failed';
		}
	}

	async function leaveGroup(id: string) {
		try {
			await cloud.leaveGroup(id);
			await loadTeams();
		} catch (e) {
			teamsMsg = e instanceof Error ? e.message : 'Leave failed';
		}
	}

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
		if (cloudToken()) {
			void refreshCloudUser().then(() => void loadTeams());
		}
	});

	function pickTheme(t: Theme) {
		theme = t;
		setTheme(t);
	}

</script>

<header class="phead">
	<div>
		<h1>Settings</h1>
		<p class="psub">Identity, appearance, startup, permissions, data</p>
	</div>
</header>

<div class="section-label">Cloud</div>
<div class="card">
	<div class="field">
		<label for="cloud-base">Server</label>
		<div class="row">
			<input
				id="cloud-base"
				class="input mono"
				bind:value={cloudBaseUrl}
				spellcheck="false"
				placeholder="http://127.0.0.1:8080"
			/>
			<button class="btn" disabled={cloudBusy} onclick={() => void saveCloudBase()}>
				{cloudBusy ? '…' : 'Save'}
			</button>
		</div>
		<div class="hint">The Go cloud server — usage sync target and identity provider.</div>
	</div>
	{#if cloudUser}
		<div class="toggle-row">
			<span class="tname">Signed in as @{cloudUser.handle}</span>
			<span class="hint" style="margin: 0">{cloudUser.email || 'cloud account'}</span>
			<button class="btn" onclick={() => void doLogout()}>Sign out</button>
		</div>
	{:else}
		<div class="toggle-row">
			<span class="tname">Sign in</span>
			<span class="hint" style="margin: 0">
				{loginState || 'Google or Microsoft — the browser dance returns here'}
			</span>
			<span style="display: flex; gap: 8px">
				<button class="btn" disabled={loginBusy !== null} onclick={() => void doLogin('google')}>
					{loginBusy === 'google' ? '…' : 'Google'}
				</button>
				<button class="btn" disabled={loginBusy !== null} onclick={() => void doLogin('microsoft')}>
					{loginBusy === 'microsoft' ? '…' : 'Microsoft'}
				</button>
			</span>
		</div>
	{/if}
	{#if cloudError}<div class="hint" style="color: var(--bad)">{cloudError}</div>{/if}
</div>

<div class="section-label">Account</div>
<div class="card">
	<div class="field" style="display: flex; gap: 14px; align-items: flex-start">
		{#if cloudUser}
			<AvatarUpload
				user={cloudUser}
				onSaved={(u) => {
					cloudUser = u;
				}}
			/>
		{/if}
		<div style="flex: 1; min-width: 0">
			{#if cloudUser}
				<label for="display-name">Display name</label>
				<div class="row" style="margin-bottom: 10px">
					<input id="display-name" class="input" bind:value={displayName} spellcheck="false" />
				</div>
			{/if}
			<label for="handle">Handle</label>
			<div class="row">
				<span class="at">@</span>
				<input id="handle" class="input" bind:value={settings.handle} spellcheck="false" />
				<button class="btn" onclick={saveAccount}>
					{cloudUser ? (accountMsg || 'Save') : saved ? 'Saved' : 'Save'}
				</button>
				{#if !cloudUser}
					<a class="btn" href="/@{settings.handle.trim() || 'me'}">View profile</a>
				{/if}
			</div>
			{#if accountMsg && cloudUser}<div class="hint">{accountMsg}</div>{/if}
			<div class="hint">
				{#if cloudUser}
					Cloud identity — handle is unique across the server, photo uploads as 256px webp.
				{:else}
					Your local identity — used on the profile page and, later, leaderboard publishing. Sign in above for cloud identity.
				{/if}
			</div>
		</div>
	</div>
</div>

{#if cloudUser}
	<div class="section-label">Teams & groups</div>
	<div class="card">
		{#if teams.length === 0}
			<div class="empty">No teams yet — create one or join with an invite code</div>
		{:else}
			{#each teams as t (t.id)}
				<div class="team">
					<div class="toggle-row">
						<span class="tname">{t.name}</span>
						<span class="hint" style="margin: 0">
							{t.role} · {t.members ?? 0} member{(t.members ?? 0) === 1 ? '' : 's'}
							{#if t.join_code} · code <button class="codebtn" onclick={() => copy(t.join_code ?? '', `tc-${t.id}`)} title="Copy invite code">{copied === `tc-${t.id}` ? 'copied' : t.join_code}</button>{/if}
						</span>
						<button class="btn" onclick={() => void leaveTeam(t.id)}>Leave</button>
					</div>
					{#each groupsByTeam[t.id] ?? [] as g (g.id)}
						<div class="toggle-row sub">
							<span class="tname">{g.name}</span>
							<span class="hint" style="margin: 0">
								{g.role} · {g.members ?? 0} member{(g.members ?? 0) === 1 ? '' : 's'}
								{#if g.join_code} · code <button class="codebtn" onclick={() => copy(g.join_code ?? '', `gc-${g.id}`)} title="Copy invite code">{copied === `gc-${g.id}` ? 'copied' : g.join_code}</button>{/if}
							</span>
							<button class="btn" onclick={() => void leaveGroup(g.id)}>Leave</button>
						</div>
					{/each}
					<div class="row" style="margin-top: 8px">
						<input
							class="input"
							placeholder="New group name"
							bind:value={newGroupName[t.id]}
							onkeydown={(e) => {
								if (e.key === 'Enter') void createGroup(t.id);
							}}
						/>
						<button class="btn" onclick={() => void createGroup(t.id)}>Add group</button>
					</div>
				</div>
			{/each}
		{/if}
		<div class="row" style="margin-top: 12px">
			<input
				class="input"
				placeholder="New team name"
				bind:value={newTeamName}
				onkeydown={(e) => {
					if (e.key === 'Enter') void createTeam();
				}}
			/>
			<button class="btn" onclick={() => void createTeam()}>Create</button>
		</div>
		<div class="row" style="margin-top: 8px">
			<input
				class="input mono"
				placeholder="Invite code"
				bind:value={joinCode}
				onkeydown={(e) => {
					if (e.key === 'Enter') void joinTeam();
				}}
			/>
			<button class="btn" onclick={() => void joinTeam()}>Join team</button>
			<input
				class="input mono"
				placeholder="Group code"
				bind:value={joinGroupCode}
				onkeydown={(e) => {
					if (e.key === 'Enter') void joinGroup();
				}}
			/>
			<button class="btn" onclick={() => void joinGroup()}>Join group</button>
		</div>
		{#if teamsMsg}<div class="hint" style="color: var(--bad)">{teamsMsg}</div>{/if}
	</div>
{/if}

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
	.toggle-row.sub {
		padding-left: 18px;
	}
	.team + .team {
		margin-top: 6px;
		padding-top: 6px;
		border-top: 1px solid var(--line);
	}
	.codebtn {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text);
		cursor: pointer;
		text-decoration: underline dotted;
	}
	.tname {
		font-size: 13px;
		font-weight: 500;
	}
</style>
