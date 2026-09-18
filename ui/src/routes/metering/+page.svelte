<script lang="ts">
	import { onMount } from 'svelte';
	import { api, type RuntimeInfo, type Meters } from '$lib/api';
	import { connection } from '$lib/connection.svelte';
	import { poll } from '$lib/format';
	import { compareProviders } from '$lib/popularity';
	import MeterTiles from '$lib/components/metering/MeterTiles.svelte';
	import RuntimeCards from '$lib/components/metering/RuntimeCards.svelte';
	import RecoverySection from '$lib/components/metering/RecoverySection.svelte';
	import MeterSettingsModal from '$lib/components/metering/MeterSettingsModal.svelte';
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

	/** Runtimes by curated popularity (see $lib/popularity). */
	const running = $derived(
		runtimes.filter((r) => r.running).sort((a, b) => compareProviders(a.vendor, b.vendor))
	);
	const runningVendors = $derived(new Set((meters?.point ?? []).map((m) => m.vendor)));
	/** Self-managed runtimes known to the daemon (running or not) — only
	 *  these have configurable endpoints; cloud API bases are fixed. */
	const runtimeVendors = $derived(new Set(runtimes.map((r) => r.vendor.toLowerCase())));
	const liveMeters = $derived(new Map((meters?.point ?? []).map((m) => [m.vendor.toLowerCase(), m])));
	/** Catalog by curated popularity (see $lib/popularity — editorial, not
	 *  traffic, so tiles never reshuffle as you work. Drops the backend
	 *  alias twin (MeterRegistry.aliases lists google ⇔ gemini, but one
	 *  adapter ("gemini") and one default port (9250) serve both — two
	 *  tiles would split attribution and fight over the port). */
	const catalog = $derived(
		[...(meters?.catalog ?? [])]
			.filter(
				(c, _, arr) =>
					c.vendor.toLowerCase() !== 'google' ||
					!arr.some((o) => o.vendor.toLowerCase() === 'gemini')
			)
			.sort((a, b) => compareProviders(a.vendor, b.vendor))
	);

	/** Runtime active (or has usage) but no meter listening — enable it. */
	const unmeteredActive = $derived(
		runtimes.filter((r) => {
			const k = r.vendor.toLowerCase();
			return (r.running || r.usage.tokens_all > 0) && !liveMeters.has(k);
		})
	);

	const consentDenied = (s: string) =>
		consents.length > 0 && !(consents.find((c) => c.scope === s)?.granted ?? false);
	const recoveryOpen = $derived(
		daemonDown ||
			(meters?.point ?? []).length > 0 ||
			unmeteredActive.length > 0 ||
			consentDenied('metering') ||
			consentDenied('fileReading')
	);

	/** Meter settings modal target (vendor key + display title). */
	let settingsTarget = $state<{ vendor: string; title: string } | null>(null);

	async function refreshMeters() {
		try {
			meters = await api.meters();
		} catch {
			/* daemon down */
		}
	}
</script>

<MeterTiles
	{catalog}
	{meters}
	{runtimeVendors}
	onToggle={(v, on) => void toggleMeter(v, on)}
	onSettings={(v) => (settingsTarget = { vendor: v, title: v })}
/>

<RuntimeCards
	{running}
	{histories}
	{runningVendors}
	onSettings={(v, t) => (settingsTarget = { vendor: v, title: t })}
/>

<RecoverySection
	open={recoveryOpen}
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

<MeterSettingsModal
	open={settingsTarget != null}
	onClose={() => (settingsTarget = null)}
	vendor={settingsTarget?.vendor ?? ''}
	title={settingsTarget?.title ?? ''}
	{meters}
	onSaved={() => void refreshMeters()}
/>
