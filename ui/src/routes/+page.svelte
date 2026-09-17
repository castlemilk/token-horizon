<script lang="ts">
	import { onMount } from 'svelte';
	import { fetchDailyActivity, type DayActivity } from '$lib/activity';
	import { settings } from '$lib/settings.svelte';
	import { poll } from '$lib/format';
	import HeatmapWidget from '$lib/components/widgets/heatmap/HeatmapWidget.svelte';
	import CountersWidget from '$lib/components/widgets/counters/CountersWidget.svelte';
	import ActivityBarsWidget from '$lib/components/widgets/activity/ActivityBarsWidget.svelte';
	import ProviderWidget from '$lib/components/widgets/providers/ProviderWidget.svelte';
	import RecentWidget from '$lib/components/widgets/recent/RecentWidget.svelte';

	/** Home is just the widget bento now — every widget owns its data
	 *  except the heatmap, which shares this trailing-year feed. */
	let days = $state<DayActivity[]>([]);

	async function loadDays() {
		try {
			days = await fetchDailyActivity(365, !settings.showImports);
		} catch {
			/* daemon down — widgets show their own empty states */
		}
	}

	onMount(() => poll(loadDays, 30000));
</script>

	<div class="dash">
	<section class="widget-grid" aria-label="Widgets">
		<div class="wcell counter">
			<CountersWidget variant="small" />
		</div>
		<div class="wcell heat">
			{#if days.length > 0}
				<HeatmapWidget {days} variant="medium" />
			{:else}
				<div class="empty">…</div>
			{/if}
		</div>
		<div class="wcell act">
			<ActivityBarsWidget variant="small" />
		</div>
		<div class="wcell rec">
			<RecentWidget variant="small" />
		</div>
		<div class="wcell prov">
			<ProviderWidget variant="small" />
		</div>
	</section>
</div>

<style>
	/* centered 3×2 bento — fills exactly the viewport between the
	   shell padding and the fixed bottom bar, so centering is true */
	.dash {
		container-type: inline-size;
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: calc(100svh - 116px);
		margin-top: 12px;
	}
	.widget-grid {
		width: min(620px, 100%);
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 200px));
		grid-template-areas:
			'counter heat heat'
			'act rec prov';
		gap: 10px;
		align-items: start;
		justify-content: center;
	}
	.widget-grid .wcell {
		min-width: 0;
		display: flex;
		justify-content: center;
	}
	.widget-grid .wcell.counter { grid-area: counter; }
	.widget-grid .wcell.heat { grid-area: heat; }
	/* heatmap runs exactly two smalls plus one gap: 2×200 + 10 */
	.widget-grid .wcell.heat :global(.hwidget.md) {
		max-width: 410px;
	}
	/* tiles never compress below a usable width — on tiny screens they
	   hold their size and center instead of distorting into strips */
	.widget-grid :global(.hwidget.sm) {
		min-width: 160px;
	}
	.widget-grid .wcell.act { grid-area: act; }
	.widget-grid .wcell.rec { grid-area: rec; }
	.widget-grid .wcell.prov { grid-area: prov; }
	.empty {
		color: var(--text-3);
		font-size: 13px;
	}
	/* small screens: medium heatmap leads, counter joins the pairs —
	   5 widgets over 3 rows, one uniform gap both axes */
	@media (max-width: 640px) {
		.dash {
			margin-top: 20px;
		}
		.widget-grid {
			width: min(410px, 100%);
			grid-template-columns: repeat(2, minmax(0, 200px));
			justify-content: center;
			grid-template-areas:
				'heat heat'
				'counter act'
				'rec prov';
		}
	}
</style>
