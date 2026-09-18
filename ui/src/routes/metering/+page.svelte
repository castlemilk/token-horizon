<script lang="ts">
	import { onMount } from 'svelte';
	import { api, type RuntimeInfo, type Meters } from '$lib/api';
	import { connection } from '$lib/connection.svelte';
	import { poll } from '$lib/format';
	import MeterTiles from '$lib/components/metering/MeterTiles.svelte';
	import RuntimeCards from '$lib/components/metering/RuntimeCards.svelte';
	import RecoverySection from '$lib/components/metering/RecoverySection.svelte';
	import type { ConsentState, ServiceStatus } from '$lib/api';

	let runtimes = $state<RuntimeInfo[]>([]);
	let histories = $state<Record<string, number[]>>({});
	let meters = $state<Meters | null>(null);
	let consents = $state<ConsentState[]>([]);
	let service = $state<ServiceStatus | null>(null);
	/** Shared connection state — auto-reconnects with backoff, so this page
	 *  recovers on its own instead of latching a local down flag. */
	const daemonDown = $derived(connection.status === 'offline');

	onMount(() =>
		poll(async () => {
			try {
				[runtimes, meters] = await Promise.all([api.runtimes(), api.meters()]);
				// tok/s history per running runtime (coarse 30s rollups).
				for (const rt of runtimes.filter((r) => r.running)) {
					if (histories[rt.vendor]) continue;
					api.runtimeHistory(rt.vendor, true)
						.then((h) => {
							histories = {
								...histories,
								[rt.vendor]: h.points.map((p) => p.tok_per_sec ?? 0)
							};
						})
						.catch(() => {});
				}
			} catch {
				return;
			}
			try {
				consents = (await api.consents().catch(() => null))?.scopes ?? [];
			} catch {
				/* pre-consents daemon — treat as unknown, not denied */
			}
			try {
				service = await api.serviceStatus().catch(() => null);
			} catch {
				/* leave previous */
			}
		}, 4000)
	);

	async function toggleMeter(vendor: string, enabled: boolean) {
		try {
			await api.toggleMeter(vendor, enabled);
		} catch {
			/* consent missing or bind failed — the refresh below shows truth */
		}
		try {
			meters = await api.meters();
		} catch {
			/* daemon down */
		}
	}

	async function setConsent(scope: string, granted: boolean) {
		try {
			await api.setConsent(scope, granted);
			consents = (await api.consents().catch(() => null))?.scopes ?? consents;
			meters = await api.meters().catch(() => meters);
		} catch {
			/* daemon down — recovery card shows it */
		}
	}

	async function installSvc() {
		try {
			service = await api.installService();
		} catch {
			/* unsupported — card shows the manual path */
		}
	}

	const running = $derived(
		runtimes.filter((r) => r.running).sort((a, b) => b.usage.tokens_all - a.usage.tokens_all)
	);
	const runningVendors = $derived(new Set((meters?.point ?? []).map((m) => m.vendor)));
	const liveMeters = $derived(new Map((meters?.point ?? []).map((m) => [m.vendor.toLowerCase(), m])));
	/** Catalog ordered by popularity: live meters first, then most-measured
	 *  traffic, alphabetical tiebreak — the vendors you actually use lead. */
	const catalog = $derived(
		[...(meters?.catalog ?? [])].sort((a, b) => {
			if (a.running !== b.running) return a.running ? -1 : 1;
			const traffic = (v: string) => {
				const m = liveMeters.get(v.toLowerCase());
				return (m?.seen ?? 0) + (m?.measured ?? 0);
			};
			return traffic(b.vendor) - traffic(a.vendor) || a.vendor.localeCompare(b.vendor);
		})
	);

	/** Runtime active (or has usage) but no meter listening — enable it. */
	const unmeteredActive = $derived(
		runtimes.filter((r) => {
			const k = r.vendor.toLowerCase();
			return (r.running || r.usage.tokens_all > 0) && !liveMeters.has(k);
		})
	);
</script>

<MeterTiles {catalog} {meters} onToggle={(v, on) => void toggleMeter(v, on)} />

<RuntimeCards
	{running}
	{histories}
	{liveMeters}
	{runningVendors}
	{meters}
	onMeters={(m) => (meters = m)}
/>

<RecoverySection
	{daemonDown}
	{service}
	{consents}
	{unmeteredActive}
	{liveMeters}
	{meters}
	onToggleMeter={(v, on) => void toggleMeter(v, on)}
	onConsent={(s, g) => void setConsent(s, g)}
	onInstallSvc={() => void installSvc()}
/>
