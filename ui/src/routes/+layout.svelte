<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { api, type Health, type RuntimeInfo } from '$lib/api';
	import { connection } from '$lib/connection.svelte';
	import { settings } from '$lib/settings.svelte';
	import { scope } from '$lib/scope.svelte';
	import ScopeBanner from '$lib/components/feedback/ScopeBanner.svelte';
	import OSIcon from '$lib/components/data/OSIcon.svelte';
	import Onboarding from '$lib/components/feedback/Onboarding.svelte';
	import RingsBackground from '$lib/components/feedback/RingsBackground.svelte';
	import CloudAuthModal from '$lib/components/account/CloudAuthModal.svelte';
	import { cloud, cloudToken, type CloudUser } from '$lib/cloud';
	import { House, Activity, Settings, PlugZap, Unplug, Trophy, Cloud } from 'lucide-svelte';

	let { children } = $props();

	// Single shared connection: auto-reconnects with backoff + port
	// rediscovery; every page reads connection.status instead of failing alone.
	const health = $derived<Health | null>(connection.health);
	const down = $derived(connection.status === 'offline');
	const connecting = $derived(connection.status === 'connecting');
	let runtimes = $state<RuntimeInfo[]>([]);

	const mountTime = Date.now();

	onMount(() => {
		const stopScope = scope.start();
		connection.start();
		// Lenis smooth scroll (skipped for reduced-motion): buttery wheel
		// inertia over the whole app shell. autoRaf drives its own loop.
		let lenis: { destroy: () => void } | null = null;
		const reduceMotion =
			typeof matchMedia !== 'undefined' &&
			matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (!reduceMotion) {
			import('lenis')
				.then(({ default: Lenis }) => {
					lenis = new Lenis({ autoRaf: true, lerp: 0.09, smoothWheel: true });
				})
				.catch(() => {});
		}
		const checkRuntimes = async () => {
			if (!connection.online) return;
			try {
				runtimes = await api.runtimes();
			} catch {
				/* tab visibility just stays off */
			}
		};
		void checkRuntimes();
		const id = setInterval(checkRuntimes, 5000);
		return () => {
			clearInterval(id);
			lenis?.destroy();
			lenis = null;
			stopScope();
		};
	});

	// Splash dismissal: once mounted AND the first health check has resolved
	// (up or down), fade + remove. Min display time avoids a flash.
	$effect(() => {
		if (connecting) return; // first check still in flight
		const splash = document.getElementById('th-splash');
		if (!splash) return;
		const wait = Math.max(0, 450 - (Date.now() - mountTime));
		const t = setTimeout(() => {
			splash.classList.add('sp-done');
			setTimeout(() => splash.remove(), 300);
		}, wait);
		return () => clearTimeout(t);
	});

	// Metering tab shows whenever the daemon reports runtimes — even all
	// stopped (the page itself explains setup). Gating on running/usage
	// made the tab vanish on idle machines, which reads as broken chrome.
	// Hidden only while the daemon is unreachable (empty list).
	const machineAvailable = $derived(runtimes.length > 0);

	// Icon tabs — labels live on tooltips (title/aria), the UI stays wordless.
	// Home · Meters (when runtime analytics exist) · Leaderboard · Profile.
	// Both shells (Tauri + web) expose the same tabs — the Tauri webview has
	// no URL bar, so nothing needs constraining at the route level.
	const tabs = $derived(
		machineAvailable
			? [
					{ path: '/home', label: 'Home', icon: House },
					{ path: '/metering', label: 'Meters', icon: Activity },
					{ path: '/leaderboard', label: 'Leaderboard', icon: Trophy }
				]
			: [
					{ path: '/home', label: 'Home', icon: House },
					{ path: '/leaderboard', label: 'Leaderboard', icon: Trophy }
				]
	);

	const profilePath = $derived(`/@${settings.handle.trim() || 'me'}`);
	const initial = $derived((settings.handle.trim()[0] ?? '?').toUpperCase());
	const active = $derived($page.url.pathname);
	const profileActive = $derived(active.startsWith('/@'));
	// Marketing-site routes (landing + policies) render WITHOUT the app shell:
	// no island nav, no dock, no onboarding. They bring their own chrome via
	// src/routes/(site)/+layout.svelte.
	const isSite = $derived(
		active === '/' || active === '/terms' || active === '/privacy' || active === '/eula'
	);

	// Cloud connect/disconnect: the dock toggle opens the auth modal. The
	// signed-in user is resolved lazily from the stored cloud token.
	let cloudModalOpen = $state(false);
	let cloudMe = $state<CloudUser | null>(null);

	async function toggleCloud() {
		if (cloudToken()) {
			cloudMe = await cloud.me().catch(() => null);
		} else {
			cloudMe = null;
		}
		cloudModalOpen = true;
	}
</script>

{#if isSite}
	{@render children()}
{:else}
<div class="shell island-shell">
	<header class="island-wrap" data-tauri-drag-region>
		<nav class="island" aria-label="Primary">
			{#each tabs as t}
				<a href={t.path} class:active={active === t.path} title={t.label} aria-label={t.label}>
					<t.icon size={17} strokeWidth={1.8} />
				</a>
			{/each}
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
			<div class="status" title={connection.lastError ? `Local listener — ${connection.lastError}` : 'Local listener'}>
				<span class="dot" class:up={!down && health} class:down={down}></span>
				{#if health}
					<OSIcon platform={health.platform} size={13} />
					<span class="dock-text">Listener</span>
				{:else if down}
					<span class="dock-text" title={connection.lastError ?? ''}>Listener offline · retrying</span>
					<button class="dock-retry" onclick={() => connection.retry()} title="Retry now" aria-label="Retry connection">
						<PlugZap size={13} strokeWidth={2} />
					</button>
				{:else}
					<span class="dock-text">Connecting…</span>
				{/if}
			</div>
			{#if !down && health}
				<!-- Two separate signals: cloud = is the server reachable (green),
				     sign-in = is an identity applied (only meaningful — and only
				     shown — while the cloud is reachable). -->
				<button
					class="status dock-sub dock-cloud"
					title={scope.cloudLabel}
					aria-label="Cloud connection"
					onclick={() => void toggleCloud()}
				>
					<span
						class="dot"
						class:up={scope.cloudReachable}
						class:down={scope.cloudConnected && !scope.cloudReachable}
					></span>
					<Cloud size={13} strokeWidth={1.8} />
				</button>
				{#if scope.cloudReachable}
					<button
						class="status dock-sub dock-cloud"
						title={scope.cloudSignedIn
							? 'Signed in — sync enabled (click to manage)'
							: 'Not signed in — click to connect'}
						aria-label={scope.cloudSignedIn ? 'Signed in' : 'Sign in'}
						onclick={() => void toggleCloud()}
					>
						<span class="dot" class:up={scope.cloudSignedIn}></span>
						{#if scope.cloudSignedIn}
							<Unplug size={13} strokeWidth={1.8} />
						{:else}
							<PlugZap size={13} strokeWidth={1.8} />
						{/if}
					</button>
				{/if}
			{/if}
			<a class="dock-gear" href="/settings" class:active={active === '/settings'} title="Settings" aria-label="Settings">
				<Settings size={14} strokeWidth={1.8} />
			</a>
		</div>
	</footer>
</div>
<!-- Backdrop mounts last so its setup can never block siblings' onMount -->
<RingsBackground />
<CloudAuthModal
	open={cloudModalOpen}
	user={cloudMe}
	onClose={() => {
		cloudModalOpen = false;
		void scope.poke();
	}}
/>
{/if}
