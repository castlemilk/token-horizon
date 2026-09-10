<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { api, apiBase, type Health } from '$lib/api';

	let { children } = $props();

	let health = $state<Health | null>(null);
	let down = $state(false);

	onMount(() => {
		const check = async () => {
			try {
				health = await api.health();
				down = false;
			} catch {
				down = true;
			}
		};
		void check();
		const id = setInterval(check, 5000);
		return () => clearInterval(id);
	});

	const tabs = [
		{ path: '/', label: 'OVERVIEW' },
		{ path: '/providers', label: 'PROVIDERS' },
		{ path: '/requests', label: 'REQUESTS' },
		{ path: '/trends', label: 'TRENDS' },
		{ path: '/limits', label: 'LIMITS' }
	];
</script>

<div class="shell">
	<header class="topbar">
		<span class="brand">TOKEN HORIZON</span>
		<nav class="tabs">
			{#each tabs as t}
				<a href={t.path} class:active={$page.url.pathname === t.path}>{t.label}</a>
			{/each}
		</nav>
		<div class="status">
			<span class="dot" class:up={!down && health} class:down={down}></span>
			{#if health}
				{health.name} · {health.platform} · {apiBase()}
			{:else if down}
				daemon unreachable at {apiBase()}
			{:else}
				connecting…
			{/if}
		</div>
	</header>
	{@render children()}
</div>
