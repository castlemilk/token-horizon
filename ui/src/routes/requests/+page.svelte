<script lang="ts">
	import { onMount } from 'svelte';
	import { api, type UsageEvent } from '$lib/api';
	import { fmtTok, fmtTime, totalTok, poll } from '$lib/format';
	import { scope } from '$lib/scope.svelte';

	let events = $state<UsageEvent[]>([]);
	let cursor = $state<number | null>(null);
	let vendorFilter = $state('');
	// Machine scope: '' = all machines in the local DB. Chips appear only
	// when off-machine (synced) rows exist; the filter accepts alias or id.
	let machineFilter = $state('');

	const load = async (append = false) => {
		try {
			const qs = new URLSearchParams();
			qs.set('limit', '100');
			if (vendorFilter) qs.set('vendor', vendorFilter);
			if (machineFilter) qs.set('machine', machineFilter);
			const page = await api.events(`?${qs}`, append ? (cursor ?? undefined) : undefined);
			events = append ? [...events, ...page.events] : page.events;
			cursor = page.next_cursor;
		} catch {
			/* daemon down */
		}
	};

	onMount(() => poll(() => load(false), 4000));

	const vendors = $derived([...new Set(events.map((e) => e.vendor))].sort());
	// Local machine chip label: its alias; off-machine chips: their key.
	const machineChips = $derived(scope.multiMachine ? scope.machines : []);
</script>

<div class="section-label">Requests · Newest first</div>
<div class="row" style="margin-bottom: 10px; gap: 10px; flex-wrap: wrap">
	<div class="seg" role="group" aria-label="Vendor filter">
		<button class:active={vendorFilter === ''} onclick={() => { vendorFilter = ''; void load(); }}>All</button>
		{#each vendors as v}
			<button class:active={vendorFilter === v} onclick={() => { vendorFilter = v; void load(); }}>{v}</button>
		{/each}
	</div>
	{#if machineChips.length > 0}
		<div class="seg" role="group" aria-label="Machine scope">
			<button class:active={machineFilter === ''} onclick={() => { machineFilter = ''; void load(); }}>
				All machines
			</button>
			{#each machineChips as m}
				<button
					class:active={machineFilter === m.key}
					title={m.isLocal ? 'this machine' : `synced from cloud${scope.offMachineFresh ? '' : ' (may be stale)'}`}
					onclick={() => { machineFilter = m.key; void load(); }}
				>
					{m.isLocal ? `${m.key} (here)` : m.key}
				</button>
			{/each}
		</div>
	{/if}
</div>

{#if events.length === 0}
	<div class="empty">No metered requests yet</div>
{:else}
	<div class="card" style="padding: 4px 6px">
		<table>
			<thead>
				<tr>
					<th>Time</th><th>Vendor</th><th>Model</th><th>Product</th>
					{#if scope.multiMachine}<th>Machine</th>{/if}
					<th class="right">Tokens</th><th class="right">Gen tok/s</th><th class="right">Thinking</th>
				</tr>
			</thead>
			<tbody>
				{#each events as e}
					<tr>
						<td class="dim num">{fmtTime(e.timestamp)}</td>
						<td>{e.vendor}</td>
						<td class="mono dim">{e.model || '—'}</td>
						<td class="faint">{e.product ?? '—'}</td>
						{#if scope.multiMachine}
							<td class="faint">{e.machineAlias ?? e.machineID ?? '—'}</td>
						{/if}
						<td class="right num">{fmtTok(totalTok(e.tokens))}</td>
						<td class="right num accent">{e.generationTokPerSec != null ? e.generationTokPerSec.toFixed(1) : '—'}</td>
						<td class="right faint">{e.thinkingLevel ?? '—'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if cursor != null}
		<div style="margin-top: 10px; text-align: center">
			<button class="btn" onclick={() => load(true)}>Load more</button>
		</div>
	{/if}
{/if}
