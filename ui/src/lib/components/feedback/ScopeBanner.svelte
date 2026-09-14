<script lang="ts">
	// Data-scope banner: rendered only when the user needs to know that what
	// they see is NOT the whole picture —
	//   degraded: cloud configured but unreachable → off-machine rows may be
	//             stale; on-machine data (this machine's tools + self-hosted
	//             runtimes) is unaffected and still live.
	//   off:      cloud not configured → single-machine mode (shown only when
	//             off-machine machines were previously visible, i.e. never —
	//             so in practice this stays quiet; the topbar chip suffices).
	import { scope } from '$lib/scope.svelte';
	import { fmtTime } from '$lib/format';

	const degraded = $derived(scope.cloud === 'degraded');
	const lastSyncText = $derived(
		scope.lastSync != null ? `last sync ${fmtTime(scope.lastSync)}` : 'no successful sync yet'
	);
</script>

{#if degraded}
	<div class="scope-banner" role="status">
		<span class="scope-dot"></span>
		<span>
			Cloud unreachable — showing <strong>{scope.thisMachineName}</strong> live;
			off-machine data may be stale ({lastSyncText}).
		</span>
	</div>
{/if}

<style>
	.scope-banner {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 14px;
		font-size: 11.5px;
		color: var(--warn);
		border-bottom: 1px solid var(--line);
		background: light-dark(rgb(154 103 0 / 0.06), rgb(212 167 44 / 0.08));
	}
	.scope-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--warn);
		flex: none;
	}
	.scope-banner strong {
		font-weight: 600;
	}
</style>
