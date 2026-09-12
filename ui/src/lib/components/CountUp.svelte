<script lang="ts">
	import { tweened, type Tweened } from 'svelte/motion';
	import { cubicOut } from 'svelte/easing';
	import { fmtTok } from '$lib/format';

	let {
		value,
		format = fmtTok,
		duration = 700
	}: { value: number; format?: (n: number) => string; duration?: number } = $props();

	const reduce =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	let shown: Tweened<number> | null = $state(null);

	$effect(() => {
		if (!shown) {
			shown = tweened(value, { duration: reduce ? 0 : duration, easing: cubicOut });
		} else {
			shown.set(value);
		}
	});

	const digits = '0123456789';
	const chars = $derived((format($shown ?? value)).split(''));
	const isDigit = (c: string) => c >= '0' && c <= '9';
</script>

{#if reduce}
	<span>{format(value)}</span>
{:else}
	<span class="roller" aria-label={format(value)}>
		{#each chars as c, i (i)}
			{#if isDigit(c)}
				<span class="rd"><span class="rd-strip" style="transform: translateY(-{+c}em)">{#each digits as d}<span>{d}</span>{/each}</span></span>
			{:else}
				<span class="rstatic">{c}</span>
			{/if}
		{/each}
	</span>
{/if}

<style>
	.roller {
		display: inline-flex;
		font-variant-numeric: tabular-nums;
	}
	.rd {
		display: inline-block;
		height: 1em;
		overflow: hidden;
		line-height: 1;
	}
	.rd-strip {
		display: flex;
		flex-direction: column;
		line-height: 1;
		will-change: transform;
	}
	.rd-strip > span {
		height: 1em;
		line-height: 1;
	}
	.rstatic {
		line-height: 1;
	}
</style>
