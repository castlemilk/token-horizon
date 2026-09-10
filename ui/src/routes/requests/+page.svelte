<script lang="ts">
	import { onMount } from 'svelte';
	import { api, type UsageEvent } from '$lib/api';
	import { fmtTok, fmtTime, totalTok, poll } from '$lib/format';

	let events = $state<UsageEvent[]>([]);
	let cursor = $state<number | null>(null);
	let vendorFilter = $state('');

	const load = async (append = false) => {
		try {
			const params = vendorFilter ? `?vendor=${encodeURIComponent(vendorFilter)}&limit=100` : '?limit=100';
			const page = await api.events(params, append ? (cursor ?? undefined) : undefined);
			events = append ? [...events, ...page.events] : page.events;
			cursor = page.next_cursor;
		} catch {
			/* daemon down */
		}
	};

	onMount(() => poll(() => load(false), 4000));

	const vendors = $derived([...new Set(events.map((e) => e.vendor))].sort());
</script>

<div class="section-label">REQUESTS · NEWEST FIRST</div>
<div class="row" style="margin-bottom: 8px">
	<button class="chip" class:active={vendorFilter === ''} onclick={() => { vendorFilter = ''; void load(); }}>ALL</button>
	{#each vendors as v}
		<button class="chip" class:active={vendorFilter === v} onclick={() => { vendorFilter = v; void load(); }}>{v.toUpperCase()}</button>
	{/each}
</div>

{#if events.length === 0}
	<div class="empty">no metered requests yet</div>
{:else}
	<div class="card">
		<table>
			<thead>
				<tr>
					<th>TIME</th><th>VENDOR</th><th>MODEL</th><th>PRODUCT</th>
					<th class="right">TOKENS</th><th class="right">GEN TOK/S</th><th class="right">THINKING</th>
				</tr>
			</thead>
			<tbody>
				{#each events as e}
					<tr>
						<td class="dim">{fmtTime(e.timestamp)}</td>
						<td>{e.vendor}</td>
						<td class="dim">{e.model || '—'}</td>
						<td class="faint">{e.product ?? '—'}</td>
						<td class="right">{fmtTok(totalTok(e.tokens))}</td>
						<td class="right accent">{e.generationTokPerSec != null ? e.generationTokPerSec.toFixed(1) : '—'}</td>
						<td class="right faint">{e.thinkingLevel ?? '—'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if cursor != null}
		<div style="margin-top: 8px; text-align: center">
			<button class="chip" onclick={() => load(true)}>LOAD MORE</button>
		</div>
	{/if}
{/if}
