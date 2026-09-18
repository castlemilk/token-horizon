<script lang="ts">
	import { Settings2 } from 'lucide-svelte';
	import type { MeterCatalogEntry, Meters } from '$lib/api';
	import ProviderIcon from '$lib/components/data/ProviderIcon.svelte';
	import { Switch } from '$lib/components/ui/switch/index.js';

	/** Request-routing meter tiles: on/off per vendor, gear opens meter settings. */
	let {
		catalog,
		meters,
		onToggle,
		onSettings
	}: {
		catalog: MeterCatalogEntry[];
		meters: Meters | null;
		onToggle: (vendor: string, enabled: boolean) => void;
		onSettings: (vendor: string) => void;
	} = $props();
</script>

<div class="section-label">
	Request routing{meters ? ` · ${meters.mode} mode · ${meters.point.length} live` : ''}
</div>
{#if catalog.length === 0}
	<div class="empty">No meterable vendors discovered — the daemon catalog appears here</div>
{:else}
	<div class="meter-tiles">
		{#each catalog as m}
			<div class="card mtile">
				<div class="mtile-head">
					<span style="display: flex; align-items: center; gap: 7px" title={m.vendor}>
						<ProviderIcon vendor={m.vendor} size={20} />
						<strong>{m.vendor}</strong>
					</span>
					<span style="display: flex; align-items: center; gap: 6px">
						<span class="dot" class:up={m.running}></span>
						<button
							class="gear"
							onclick={() => onSettings(m.vendor)}
							title="Meter settings for {m.vendor}"
							aria-label="Meter settings for {m.vendor}"
						>
							<Settings2 size={13} strokeWidth={2} />
						</button>
					</span>
				</div>
				<div class="mono mroute" class:faint={!m.running}>127.0.0.1:{m.listen_port}</div>
				<div class="mono dim mroute">→ {m.running ? (m.target ?? '—') : 'off'}</div>
				<div class="mtile-foot">
					<span class="faint">{m.running ? 'metering' : 'off'}</span>
					<Switch
						checked={m.running}
						onCheckedChange={(v) => onToggle(m.vendor, v)}
						aria-label="Meter {m.vendor}"
					/>
				</div>
			</div>
		{/each}
	</div>
	<div class="hint" style="margin: 6px 0 0 2px; font-size: 11px; color: var(--text-3)">
		Point a tool at its listen URL and its traffic gets measured on the way
		through — nothing else changes. Switches stick; local runtimes pick up
		metering on their own unless you turn them off here.
	</div>
{/if}

<style>
	/* request routing as tiles: side by side when roomy, one long
	   column when not */
	.meter-tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
		gap: 10px;
	}
	.mtile-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		font-size: 12.5px;
		margin-bottom: 6px;
	}
	.mtile {
		padding: 13px 14px;
	}
	.mroute {
		font-size: 10.5px;
		line-height: 1.5;
		overflow-x: auto;
		white-space: nowrap;
	}
	.mtile-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 8px;
		font-size: 11px;
	}
	.gear {
		appearance: none;
		border: 0;
		background: transparent;
		color: var(--text-3);
		width: 24px;
		height: 24px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}
	.gear:hover {
		background: var(--track);
		color: var(--text);
	}
</style>
