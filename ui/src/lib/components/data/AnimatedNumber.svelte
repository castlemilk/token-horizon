<script lang="ts">
	import { untrack } from 'svelte';
	import gsap from 'gsap';

	/** Numeric text that tweens to its target with gsap whenever `value`
	 *  changes (poll updates glide instead of jumping). Renders `empty`
	 *  while null. Honors prefers-reduced-motion by snapping. */
	let {
		value,
		format = (n: number) => `${Math.round(n)}`,
		empty = '…'
	}: {
		value: number | null;
		format?: (n: number) => string;
		empty?: string;
	} = $props();

	const reduce =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	let shown = $state<number | null>(null);
	let tween: gsap.core.Tween | null = null;

	$effect(() => {
		const target = value;
		if (target == null) {
			tween?.kill();
			shown = null;
			return;
		}
		// Unknown so far glides up from zero on first paint.
		const from = untrack(() => shown) ?? 0;
		if (reduce || from === target) {
			tween?.kill();
			shown = target;
			return;
		}
		tween?.kill();
		const o = { v: from };
		tween = gsap.to(o, {
			v: target,
			duration: 0.6,
			ease: 'power2.out',
			onUpdate: () => (shown = o.v),
			onComplete: () => (shown = target)
		});
		return () => tween?.kill();
	});
</script>

{shown == null ? empty : format(shown)}
