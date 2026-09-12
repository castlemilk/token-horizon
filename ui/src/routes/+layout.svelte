<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { api, setApiBase, discoverApiBase, type Health, type RuntimeInfo } from '$lib/api';
	import { settings } from '$lib/settings.svelte';
	import { scope } from '$lib/scope.svelte';
	import ScopeBanner from '$lib/components/ScopeBanner.svelte';
	import OSIcon from '$lib/components/OSIcon.svelte';
	import Onboarding from '$lib/components/Onboarding.svelte';
	import { Coins, Trophy, Cpu, Gauge, Settings } from 'lucide-svelte';

	let { children } = $props();

	let health = $state<Health | null>(null);
	let down = $state(false);
	let runtimes = $state<RuntimeInfo[]>([]);

	const mountTime = Date.now();

	onMount(() => {
		const stopScope = scope.start();
		const check = async () => {
			try {
				health = await api.health();
				down = false;
			} catch {
				// Default base failed — maybe the daemon port-scanned. Discover
				// it ourselves instead of asking the user for a URL.
				const found = await discoverApiBase();
				if (found) {
					setApiBase(found);
					try {
						health = await api.health();
						down = false;
					} catch {
						down = true;
					}
				} else {
					down = true;
				}
			}
			try {
				runtimes = await api.runtimes();
			} catch {
				/* tab visibility just stays off */
			}
		};
		void check();
		const id = setInterval(check, 5000);
		return () => {
			clearInterval(id);
			stopScope();
		};
	});

	// Splash dismissal: once mounted AND the first health check has resolved
	// (up or down), fade + remove. Min display time avoids a flash.
	$effect(() => {
		if (health === null && !down) return; // first check still in flight
		const splash = document.getElementById('th-splash');
		if (!splash) return;
		const wait = Math.max(0, 450 - (Date.now() - mountTime));
		const t = setTimeout(() => {
			splash.classList.add('sp-done');
			setTimeout(() => splash.remove(), 300);
		}, wait);
		return () => clearTimeout(t);
	});

	// Machine tab appears when runtime analytics are actually available:
	// something running locally or a runtime with measured usage.
	const machineAvailable = $derived(
		runtimes.some((r) => r.running || r.usage.tokens_all > 0)
	);

	// Icon tabs — labels live on tooltips (title/aria), the UI stays wordless.
	const baseTabs = [
		{ path: '/', label: 'Tokens', icon: Coins },
		{ path: '/leaderboard', label: 'Leaderboard', icon: Trophy }
	];
	const tailTabs = [
		{ path: '/limits', label: 'Limits', icon: Gauge }
	];
	const tabs = $derived(
		machineAvailable
			? [...baseTabs, { path: '/machine', label: 'Machine', icon: Cpu }, ...tailTabs]
			: [...baseTabs, ...tailTabs]
	);

	const profilePath = $derived(`/@${settings.handle.trim() || 'me'}`);
	const initial = $derived((settings.handle.trim()[0] ?? '?').toUpperCase());
	const active = $derived($page.url.pathname);
	const profileActive = $derived(active.startsWith('/@'));
</script>

<div class="shell island-shell">
	<header class="island-wrap" data-tauri-drag-region>
		<nav class="island" aria-label="Primary">
			{#each tabs as t}
				<a href={t.path} class:active={active === t.path} title={t.label} aria-label={t.label}>
					<t.icon size={17} strokeWidth={1.8} />
				</a>
			{/each}
			<span class="island-sep" aria-hidden="true"></span>
			<a
				class="island-profile"
				class:active={profileActive}
				href={profilePath}
				title="Profile"
				aria-label="Profile"
			>
				<span class="island-avatar">{initial}</span>
			</a>
		</nav>
	</header>
	<ScopeBanner />
	{@render children()}
	<Onboarding />
	<footer class="dock-wrap">
		<div class="dockbar">
			<div class="status" title="Local listener">
				<span class="dot" class:up={!down && health} class:down={down}></span>
				{#if health}
					<OSIcon platform={health.platform} size={13} />
					<span class="dock-text">Listener</span>
				{:else if down}
					<span class="dock-text">Listener offline</span>
				{:else}
					<span class="dock-text">Connecting…</span>
				{/if}
			</div>
			{#if !down && health}
				<div class="status dock-sub" title={scope.cloudLabel}>
					<span
						class="dot"
						class:up={scope.cloud === 'synced'}
						class:down={scope.cloud === 'degraded'}
					></span>
					<span class="dock-text"
						>{scope.cloud === 'off'
							? 'Cloud off'
							: scope.cloud === 'degraded'
								? 'Cloud stale'
								: 'Cloud'}</span
					>
				</div>
			{/if}
			<a class="dock-gear" href="/settings" class:active={active === '/settings'} title="Settings" aria-label="Settings">
				<Settings size={14} strokeWidth={1.8} />
			</a>
		</div>
	</footer>
</div>
