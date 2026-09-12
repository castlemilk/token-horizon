<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { api, apiBase, type Health, type RuntimeInfo } from '$lib/api';
	import { getTheme, setTheme, type Theme } from '$lib/theme';
	import { settings } from '$lib/settings.svelte';
	import { scope } from '$lib/scope.svelte';
	import ScopeBanner from '$lib/components/ScopeBanner.svelte';

	let { children } = $props();

	let health = $state<Health | null>(null);
	let down = $state(false);
	let theme = $state<Theme>('system');
	let runtimes = $state<RuntimeInfo[]>([]);

	const mountTime = Date.now();

	onMount(() => {
		theme = getTheme();
		const stopScope = scope.start();
		const check = async () => {
			try {
				health = await api.health();
				down = false;
			} catch {
				down = true;
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

	const baseTabs = [
		{ path: '/', label: 'Tokens' },
		{ path: '/leaderboard', label: 'Leaderboard' }
	];
	const tailTabs = [
		{ path: '/requests', label: 'Requests' },
		{ path: '/limits', label: 'Limits' }
	];
	const tabs = $derived(
		machineAvailable
			? [...baseTabs, { path: '/machine', label: 'Machine' }, ...tailTabs]
			: [...baseTabs, ...tailTabs]
	);

	const themes: { id: Theme; label: string }[] = [
		{ id: 'system', label: 'Auto' },
		{ id: 'light', label: 'Light' },
		{ id: 'dark', label: 'Dark' }
	];

	function pickTheme(t: Theme) {
		theme = t;
		setTheme(t);
	}

	const initial = $derived((settings.handle.trim()[0] ?? '?').toUpperCase());
	const active = $derived($page.url.pathname);
</script>

<div class="shell">
	<header class="topbar">
		<span class="brand">Token Horizon</span>
		<nav class="tabs">
			{#each tabs as t}
				<a href={t.path} class:active={active === t.path}>{t.label}</a>
			{/each}
		</nav>
		<div class="topbar-right">
			<div class="status">
				<span class="dot" class:up={!down && health} class:down={down}></span>
				{#if health}
					{health.name} · {health.platform}
				{:else if down}
					daemon unreachable · {apiBase()}
				{:else}
					connecting…
				{/if}
			</div>
			{#if !down && health}
				<div
					class="status"
					title="{scope.cloudLabel}{scope.multiMachine ? ` · ${scope.machines.length} machines` : ''}"
				>
					<span
						class="dot"
						class:up={scope.cloud === 'synced' || scope.cloud === 'off'}
						class:down={scope.cloud === 'degraded'}
					></span>
					{scope.thisMachineName}{#if scope.multiMachine}
						&nbsp;· {scope.machines.length} machines{#if !scope.offMachineFresh}
							&nbsp;(stale){/if}{/if}
				</div>
			{/if}
			<div class="seg" role="group" aria-label="Theme">
				{#each themes as t}
					<button class:active={theme === t.id} onclick={() => pickTheme(t.id)}>{t.label}</button>
				{/each}
			</div>
			<a class="iconbtn" href="/settings" class:active={active === '/settings'} title="Settings" aria-label="Settings">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="3"></circle>
					<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
				</svg>
			</a>
			<a class="avatar" href="/@{settings.handle.trim() || 'me'}" title="Profile" aria-label="Profile">{initial}</a>
		</div>
	</header>
	<ScopeBanner />
	{@render children()}
</div>
