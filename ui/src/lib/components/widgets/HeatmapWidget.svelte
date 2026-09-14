<script lang="ts">
	import { tick } from 'svelte';
	import gsap from 'gsap';
	import Heatmap from '$lib/components/data/Heatmap.svelte';
	import {
		boxOf,
		naturalBox,
		flightVars,
		cardVars,
		spawnClones,
		removeClones,
		type Box
	} from './morph';
	import {
		activityStats,
		fetchDailyActivityRange,
		yearBounds,
		type DayActivity
	} from '$lib/activity';
	import { fmtTok } from '$lib/format';

	/** Home-screen activity widget, two sizes sharing one modal.
	 *  small: 3×3 tile — last 9 days, one dot per day.
	 *  medium: 9×3 tile — last 27 days, one dot per day.
	 *  modal: the full year (trailing 365d while the year is incomplete).
	 *
	 *  One shared container does both jobs: the tile div itself expands
	 *  into the modal on open and collapses back into the tile on close
	 *  (measure → plan → play, one GSAP timeline per direction, see
	 *  ./morph.ts). The backdrop is a sibling driven by the SAME timeline
	 *  in both directions, so the dim fades out with the collapse instead
	 *  of winking out after unmount. An invisible ghost replica holds the
	 *  grid slot while open and supplies the measured tile + dot targets
	 *  for the return flight.
	 *
	 *  `speed` scales every duration (1 = brisk default, 0.5 dreamy,
	 *  2 = instant-ish) — timing choice lives here, in the component. */
	let { days, variant, speed = 1 }: { days: DayActivity[]; variant: 'small' | 'medium'; speed?: number } =
		$props();

	const HEAT = 'light-dark(#34c759, #30d158)';
	const S = $derived(1 / (speed > 0 ? speed : 1));
	const TILE_N = $derived(variant === 'small' ? 9 : 27);
	const STAG_S = $derived((variant === 'small' ? 0.035 : 0.016) / (speed > 0 ? speed : 1));
	const BSTAG_S = $derived((variant === 'small' ? 0.022 : 0.012) / (speed > 0 ? speed : 1));
	const reduce =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	function level(tokens: number, maxV: number): number {
		if (tokens <= 0) return 0;
		const r = tokens / maxV;
		if (r <= 0.25) return 1;
		if (r <= 0.5) return 2;
		if (r <= 0.75) return 3;
		return 4;
	}

	/** Same domain as the trailing-year heatmap, so tile colors match cells. */
	const tileMax = $derived(Math.max(1, ...days.map((d) => d.tokens)));
	const tileDays = $derived(days.slice(-TILE_N));
	const tileLvls = $derived(tileDays.map((d) => level(d.tokens, tileMax)));
	const K = $derived(tileDays.length);

	const todayKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
	const live = $derived(tileDays[K - 1]?.day === todayKey && (tileDays[K - 1]?.tokens ?? 0) > 0);
	const activeK = $derived(tileDays.filter((d) => d.tokens > 0).length);
	const tileKey = $derived(tileDays.map((d) => d.tokens).join(','));

	const tip = (d: DayActivity) =>
		d.day
			? `${new Date(d.day + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} — ${d.tokens > 0 ? fmtTok(d.tokens) + ' tokens' : 'no activity'}`
			: 'no data yet';

	// ---- modal: full year ----
	const currentYear = new Date().getFullYear();
	const earliestYear = $derived(
		days.length > 0 ? new Date(days[0].ts * 1000).getFullYear() : currentYear
	);
	const minYear = $derived(Math.min(earliestYear, currentYear - 1));

	let open = $state(false);
	let year = $state(currentYear);
	let yearCache = $state<Record<number, DayActivity[]>>({});
	let loading = $state(false);
	let loadError = $state(false);
	let phase = $state<'fly' | 'settle' | 'exit'>('settle');
	let flightOk = $state(false);
	/** True briefly after a close lands: the tile remounts fresh and its
	    dots would replay their staggered pop-in (reads as reloading), so
	    entrance animation is suppressed until they settle. */
	let landed = $state(false);
	/** THE shared container: tile when closed, modal when open. Never recreated. */
	let boxEl = $state<HTMLElement | null>(null);
	let tileDotsEl = $state<HTMLElement | null>(null);
	let ghostEl = $state<HTMLElement | null>(null);
	let backdropEl = $state<HTMLElement | null>(null);
	let heatEl = $state<HTMLElement | null>(null);
	/** Flipped the frame the timeline takes over the backdrop. */
	let started = $state(false);
	let activeTl: gsap.core.Timeline | null = null;
	let timers: number[] = [];
	/** Invalidates a pending open flight scheduled via tick(). */
	let flightId = 0;
	/** Tile measurements taken while boxEl still IS the tile (pre-swap). */
	let pendingTile: { tileBox: Box; dotBoxes: Box[]; bg: string[]; fromShadow: string } | null =
		null;

	/** ?slowmo=1 slows every widget timeline — landing-frame inspection. */
	function slowmo(tl: gsap.core.Timeline): gsap.core.Timeline {
		try {
			if (new URLSearchParams(location.search).has('slowmo')) tl.timeScale(0.25);
		} catch {
			/* non-browser prerender */
		}
		return tl;
	}

	const trailing = $derived(year === currentYear);
	const yearDays = $derived<DayActivity[]>(trailing ? days : (yearCache[year] ?? []));
	const highlightFrom = $derived(
		trailing && yearDays.length >= K && K > 0 ? yearDays[yearDays.length - K].ts : undefined
	);
	const stats = $derived(activityStats(yearDays));
	const yearLabel = $derived(trailing ? 'Past 12 months' : `${year}`);
	const rangeLabel = $derived.by(() => {
		if (yearDays.length === 0) return '';
		const f = (d: DayActivity) =>
			new Date(d.day + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
		return `${f(yearDays[0])} – ${f(yearDays[yearDays.length - 1])}`;
	});

	function clearTimers() {
		for (const t of timers) clearTimeout(t);
		timers = [];
	}

	function killTl() {
		activeTl?.kill();
		activeTl = null;
	}

	/** Post-mount layout keeps shifting (heatmap auto-fits week columns to
	 *  the measured container width, fonts settle). Sampling until the heat
	 *  rect holds still guarantees the measured end boxes are final — the
	 *  reverse gets this for free on an already-settled modal. */
	function layoutStable(maxFrames = 12): Promise<void> {
		return new Promise((resolve) => {
			let last = '';
			let steady = 0;
			let n = 0;
			const sample = () => {
				n++;
				const r = heatEl?.getBoundingClientRect();
				const key = r
					? `${r.x.toFixed(1)},${r.y.toFixed(1)},${r.width.toFixed(1)},${r.height.toFixed(1)}`
					: 'null';
				steady = key === last ? steady + 1 : 0;
				last = key;
				if (steady >= 1 || n >= maxFrames) resolve();
				else requestAnimationFrame(sample);
			};
			requestAnimationFrame(sample);
		});
	}

	async function ensureYear(y: number) {
		if (y === currentYear || yearCache[y] || loading) return;
		loading = true;
		loadError = false;
		try {
			const [from, to] = yearBounds(y);
			yearCache[y] = await fetchDailyActivityRange(from, to, true);
		} catch {
			loadError = true;
		} finally {
			loading = false;
		}
	}

	function step(d: number) {
		if (phase !== 'settle') return; // never swap content mid-flight
		const next = Math.min(currentYear, Math.max(minYear, year + d));
		if (next === year) return;
		year = next;
		if (next !== currentYear) void ensureYear(next);
	}

	$effect(() => {
		if (open && !trailing) void ensureYear(year);
	});

	$effect(() => {
		if (!open) return;
		const prev = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		const onkey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') hide();
		};
		window.addEventListener('keydown', onkey);
		return () => {
			document.body.style.overflow = prev;
			window.removeEventListener('keydown', onkey);
		};
	});

	function reset() {
		killTl();
		clearTimers();
		removeClones();
		flightId++;
		const wasExit = phase === 'exit';
		// Same node persists across the swap — scrub every inline flight
		// state so the tile is whole again as the backdrop releases.
		if (boxEl) gsap.set(boxEl, { clearProps: 'all' });
		open = false;
		flightOk = false;
		started = false;
		pendingTile = null;
		phase = 'settle';
		if (wasExit) {
			// Cover the longest stagger (~600ms on medium) + pop duration.
			landed = true;
			timers.push(
				window.setTimeout(() => {
					landed = false;
				}, 800)
			);
		}
	}

	function show() {
		if (open) {
			// Reopen mid-exit: abandon the collapse and settle open.
			if (phase === 'exit') {
				killTl();
				clearTimers();
				removeClones();
				if (boxEl) gsap.set(boxEl, { clearProps: 'all' });
				phase = 'settle';
			}
			return;
		}
		killTl();
		clearTimers();
		year = currentYear;
		// Measure while boxEl still IS the tile — after the swap the tile
		// dots are gone, so their boxes + colors are stored for the plan.
		const tileBox = boxOf(boxEl);
		const dots = tileDotsEl ? [...tileDotsEl.querySelectorAll('.mdot')] : [];
		if (
			!reduce &&
			tileBox &&
			boxEl &&
			dots.length === K &&
			K > 0 &&
			tileDays.some((d) => d.day)
		) {
			const dotBoxes = dots.map(boxOf);
			if (dotBoxes.some((b) => !b)) {
				open = true;
				phase = 'settle';
				flightOk = false;
				return;
			}
			pendingTile = {
				tileBox,
				dotBoxes: dotBoxes as Box[],
				bg: dots.map((el) => getComputedStyle(el).backgroundColor),
				fromShadow: getComputedStyle(boxEl).boxShadow
			};
			flightOk = true;
			phase = 'fly';
			open = true;
			const id = ++flightId;
			void tick().then(async () => {
				if (id !== flightId) return;
				await layoutStable();
				if (id !== flightId) return;
				launchOpen(id);
			});
		} else {
			flightOk = false;
			phase = 'settle';
			open = true;
		}
	}

	/**
	 * OPEN — boxEl (the tile itself) has swapped to its modal layout;
	 * park it over the stored tile box, then play one timeline: the
	 * container expands while the dots ride clones to their year-cells,
	 * then extras fade/translate in.
	 */
	function launchOpen(id: number) {
		if (id !== flightId) return;
		if (!open || phase !== 'fly' || !boxEl || !heatEl || !pendingTile) {
			if (open && id === flightId) phase = 'settle';
			return;
		}
		const card = boxEl;
		const cardBox = boxOf(card);
		if (!cardBox) {
			phase = 'settle';
			return;
		}
		const cellEls = tileDays.map((d) => heatEl!.querySelector(`[data-ts="${d.ts}"]`));
		const cellBoxes = cellEls.map(boxOf);
		if (cellBoxes.some((b) => !b)) {
			phase = 'settle';
			return;
		}
		const pairs = pendingTile.dotBoxes.map((db, i) => ({
			from: db,
			to: cellBoxes[i] as Box,
			bg: pendingTile!.bg[i] ?? pendingTile!.bg[0]
		}));
		const clones = spawnClones(pairs);
		const landT = 0.06 + (pairs.length - 1) * STAG_S + 0.45 * S;
		const mEnd = 0.38 * S;

		const tl = slowmo(gsap.timeline({ defaults: { ease: 'power3.out' } }));
		activeTl = tl;
		started = true;

		// Backdrop ramps with everything else: dim + blur rise together.
		// Read the resting look BEFORE parking it transparent.
		const backdrop = backdropEl;
		const backdropBg = backdrop ? getComputedStyle(backdrop).backgroundColor : 'rgba(0,0,0,0)';
		if (backdrop) {
			gsap.set(backdrop, { backgroundColor: 'rgba(0,0,0,0)', '--wmodal-blur': '0px' });
			tl.to(
				backdrop,
				{
					backgroundColor: backdropBg,
					'--wmodal-blur': '14px',
					duration: 0.45 * S,
					ease: 'power1.out'
				},
				0
			);
		}

		// 1 — container + dots move together, all values precomputed.
		// Elevation travels with size (read computed, current theme):
		// a shrinking card must shed its shadow or the halo winks out
		// at unmount.
		const toShadow = getComputedStyle(card).boxShadow;
		const cv = cardVars(pendingTile.tileBox, cardBox);
		const mDur = 0.38 * S;
		const rc = { r: 18 };
		const applyRadius = () => {
			const sx = Number(gsap.getProperty(card, 'scaleX')) || 1;
			const sy = Number(gsap.getProperty(card, 'scaleY')) || 1;
			card.style.borderRadius = `${(rc.r / sx).toFixed(2)}px / ${(rc.r / sy).toFixed(2)}px`;
		};
		tl.fromTo(
			card,
			{ x: cv.dx, y: cv.dy, scaleX: cv.sx, scaleY: cv.sy, boxShadow: pendingTile.fromShadow },
			{
				x: 0,
				y: 0,
				scaleX: 1,
				scaleY: 1,
				boxShadow: toShadow,
				transformOrigin: '50% 50%',
				duration: mDur,
				ease: 'power3.inOut'
			},
			0
		);
		tl.to(rc, { r: 20, duration: mDur, ease: 'power3.inOut', onUpdate: applyRadius }, 0);
		applyRadius(); // settle corners synchronously — no one-frame pinch
		clones.forEach((c, i) => {
			const f = flightVars(pairs[i].from, pairs[i].to);
			tl.to(
				c,
				{ x: f.x, y: f.y, scale: f.scale, duration: 0.45 * S, ease: 'power3.out' },
				0.06 * S + i * STAG_S
			);
		});
		tl.to(clones, { autoAlpha: 0, duration: 0.15 * S, ease: 'power1.out' }, landT);

		// 2 — modal extras fade/translate in behind the landing. Queried
		// live off the settled card, positions derived from landT — adding
		// more content later just joins the cascade.
		const others = [...heatEl.querySelectorAll('.heatmap .cell:not(.hl)')];
		if (others.length > 0) {
			tl.fromTo(
				others,
				{ scale: 0, autoAlpha: 0 },
				{
					scale: 1,
					autoAlpha: 1,
					duration: 0.35 * S,
					ease: 'back.out(1.6)',
					stagger: { amount: 0.5 * S, from: 'end', grid: 'auto' }
				},
				landT + 0.04 * S
			);
		}
		const xstats = card.querySelectorAll('.xstat');
		if (xstats.length > 0) {
			tl.from(
				xstats,
				{ y: 12, autoAlpha: 0, duration: 0.3 * S, ease: 'power3.out', stagger: 0.06 * S },
				landT + 0.12 * S
			);
		}
		// Card chrome (title/year-picker/close) stays hidden while the shell
		// scales — visible squished text is the overlay tell — then fades in
		// once the container has landed.
		const head = card.querySelectorAll('.wmodal-head > *');
		if (head.length > 0) {
			tl.fromTo(head, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25 * S, ease: 'power1.out' }, mEnd);
		}
		const note = card.querySelector('.xnote');
		if (note) tl.from(note, { y: 5, autoAlpha: 0, duration: 0.3 * S, ease: 'power2.out' }, landT + 0.28 * S);
		const legend = card.querySelector('.heatmap .legend');
		if (legend) tl.from(legend, { autoAlpha: 0, duration: 0.4 * S, ease: 'power1.out' }, landT + 0.4 * S);
		tl.call(() => removeClones(), [], landT + 0.3);
		timers.push(
			window.setTimeout(() => {
				if (open && phase === 'fly') phase = 'settle';
			}, landT * 1000)
		);
	}

	/**
	 * CLOSE — the same container collapses back into the tile: extras
	 * dissolve, dots fly home to the ghost replica, the backdrop fades on
	 * the SAME timeline, and only then does the node drop back to tile flow.
	 *
	 * Runs from ANY choreography phase, even mid-flight: the open timeline
	 * is killed first and GSAP's inline leftovers are scrubbed off every
	 * node the exit doesn't tween. The card itself is left alone so a
	 * mid-morph collapse continues smoothly instead of snapping.
	 */
	function hide() {
		if (!open || phase === 'exit') return;
		if (reduce || !trailing) {
			// Motion-safe, or a past year whose cells aren't the tile days:
			// plain fade, never a fake flight — backdrop included.
			killTl();
			clearTimers();
			const card = boxEl;
			const backdrop = backdropEl;
			if (card && backdrop && !reduce) {
				phase = 'exit';
				const ftl = slowmo(
					gsap.timeline({ onComplete: () => reset() })
				);
				activeTl = ftl;
				ftl.to(
					[card, backdrop],
					{ autoAlpha: 0, duration: 0.18 * S, ease: 'power1.out' },
					0
				);
			} else {
				reset();
			}
			return;
		}
		killTl();
		clearTimers();
		flightId++; // cancel a still-pending open flight so it can't clobber 'exit'
		const card = boxEl;
		const ghost = ghostEl;
		if (card) {
			gsap.set(card.querySelectorAll('.heatmap .cell'), { clearProps: 'all' });
			gsap.set(card.querySelectorAll('.xstat,.xnote,.heatmap .legend'), { clearProps: 'all' });
		}
		if (!card || !ghost || !heatEl) {
			reset();
			return;
		}
		const modalBox = boxOf(card);
		const tileBox = boxOf(ghost);
		const ghostDots = [...ghost.querySelectorAll('.mdot')];
		if (!modalBox || !tileBox || ghostDots.length !== K || K === 0) {
			reset();
			return;
		}
		const dotBoxes = ghostDots.map(boxOf);
		const cellEls = tileDays.map((d) => heatEl!.querySelector(`[data-ts="${d.ts}"]`));
		const cellBoxes = cellEls.map(boxOf);
		if (dotBoxes.some((b) => !b) || cellBoxes.some((b) => !b)) {
			reset();
			return;
		}
		const bg = cellEls.map((el) => (el ? getComputedStyle(el as Element).backgroundColor : ''));
		const pairs = cellBoxes.map((cb, i) => ({
			from: cb as Box,
			to: dotBoxes[i] as Box,
			bg: bg[i] ?? bg[0]
		}));
		phase = 'exit';
		const clones = spawnClones(pairs);
		// Collapse against the NATURAL card box: GSAP offsets are relative
		// to untransformed layout, while the measured box includes any
		// in-progress morph — converging them keeps the collapse monotonic
		// instead of growing back out.
		const liveT = {
			x: Number(gsap.getProperty(card, 'x')) || 0,
			y: Number(gsap.getProperty(card, 'y')) || 0,
			scaleX: Number(gsap.getProperty(card, 'scaleX')) || 1,
			scaleY: Number(gsap.getProperty(card, 'scaleY')) || 1
		};
		// Target-form deltas: values that land the natural card onto the
		// tile — cardVars' native from-state form is cardVars(tile, card),
		// and the unswapped form inverts the collapse into a blow-up
		// (sx 2.87 instead of 0.35).
		const cv = cardVars(tileBox, naturalBox(modalBox, liveT));
		const homeShadow = getComputedStyle(ghost).boxShadow;
		// Beat 1 (CSS leaving, 0 → 0.18s) dissolves everything but the
		// travelers; beat 2 below moves container + dots home while the
		// backdrop releases on the same timeline.
		const xBase = 0.2 * S;
		const xDur = 0.32 * S;
		const xrc = { r: 20 };
		const xApplyRadius = () => {
			const sx = Number(gsap.getProperty(card, 'scaleX')) || 1;
			const sy = Number(gsap.getProperty(card, 'scaleY')) || 1;
			card.style.borderRadius = `${(xrc.r / sx).toFixed(2)}px / ${(xrc.r / sy).toFixed(2)}px`;
		};
		xApplyRadius();
		const xtl = slowmo(
			gsap.timeline({
				onComplete: () => {
					// Same node drops back to tile flow: scrub the flight
					// transform in the same tick as the content swap so the
					// tile paints exactly where the collapse landed.
					removeClones();
					reset();
				}
			})
		);
		activeTl = xtl;
		clones.forEach((c, i) => {
			const f = flightVars(pairs[i].from, pairs[i].to);
			xtl.to(
				c,
				{ x: f.x, y: f.y, scale: f.scale, duration: 0.35 * S, ease: 'power3.inOut' },
				xBase + i * BSTAG_S
			);
		});
		// Header dissolves with the rest — lingering chrome over a
		// collapsing shell reads as overlay, not morph.
		const headEls = card.querySelectorAll('.wmodal-head > *');
		if (headEls.length > 0) {
			xtl.to(headEls, { autoAlpha: 0, duration: 0.15 * S, ease: 'power1.out' }, 0);
		}
		xtl.to(
			card,
			{
				x: cv.dx,
				y: cv.dy,
				scaleX: cv.sx,
				scaleY: cv.sy,
				boxShadow: homeShadow,
				transformOrigin: '50% 50%',
				duration: xDur,
				ease: 'power3.inOut'
			},
			xBase
		);
		xtl.to(xrc, { r: 18, duration: xDur, ease: 'power3.inOut', onUpdate: xApplyRadius }, xBase);
		// The dim + blur release WITH the collapse — previously the
		// backdrop only faded after unmount, so it never visibly faded.
		const backdrop = backdropEl;
		if (backdrop) {
			xtl.to(
				backdrop,
				{
					backgroundColor: 'rgba(0,0,0,0)',
					'--wmodal-blur': '0px',
					duration: xDur,
					ease: 'power1.out'
				},
				xBase
			);
		}
		xApplyRadius();
	}

	function onTileKey(e: KeyboardEvent) {
		if (open) return;
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			show();
		}
	}
</script>

<div
	class="hwidget"
	class:sm={variant === 'small'}
	class:md={variant === 'medium'}
	class:landed={landed}
	class:pre-show={phase === 'fly' && !started}
>
	{#if open}
		<!-- Invisible replica: holds the grid slot while the shared
		     container is fixed as the modal, and supplies the measured
		     tile + dot targets for the return flight. -->
		<div class="tile-ghost" bind:this={ghostEl} aria-hidden="true">
			<span class="w-head">
				<span class="w-titles"><span class="w-title">Activity</span></span>
			</span>
			<span class="mini" class:cols9={variant === 'medium'} style:--heat={HEAT}>
				{#each tileDays as d, k}
					<span class="mdot lvl-{tileLvls[k]}"></span>
				{/each}
			</span>
			<span class="w-foot"><span class="m-foot">{activeK}/{TILE_N} active days</span></span>
		</div>
		<div
			class="wmodal-backdrop"
			bind:this={backdropEl}
			onclick={(e) => {
				if (e.target === e.currentTarget) hide();
			}}
			role="presentation"
		></div>
	{/if}
	<!-- THE container: tile when closed, modal when open. Same node both ways. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -- reason: tabindex is only 0 while role=button (tile); undefined as dialog -->
	<div
		bind:this={boxEl}
		class="morph"
		class:tile={!open}
		class:modal={open}
		class:conceal-head={open && phase === 'fly'}
		role={open ? 'dialog' : 'button'}
		aria-modal={open ? 'true' : undefined}
		aria-label={open ? 'Activity' : `Activity — ${variant === 'small' ? 'Last 9 days' : 'Last 27 days'} · tap to expand`}
		tabindex={open ? undefined : 0}
		onclick={() => {
			if (!open) show();
		}}
		onkeydown={onTileKey}
	>
		{#if !open}
			{#key tileKey}
				<span class="w-head">
					<span class="w-titles">
						<span class="w-title">Activity</span>
						<span class="w-sub"
							>{variant === 'small' ? 'Last 9 days · tap to expand' : 'Last 27 days · tap to expand'}</span
						>
					</span>
					<span class="w-expand" aria-hidden="true">
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>
					</span>
				</span>
				<span
					class="mini"
					class:cols9={variant === 'medium'}
					bind:this={tileDotsEl}
					style:--heat={HEAT}
					role="img"
					aria-label="{activeK} active days in the last {TILE_N}"
				>
					{#each tileDays as d, k}
						<span
							class="mdot lvl-{tileLvls[k]}"
							class:live={live && k === K - 1}
							style={reduce ? '' : `animation-delay: ${k * (variant === 'small' ? 55 : 22)}ms`}
							title={tip(d)}
						></span>
					{/each}
				</span>
				<span class="w-foot"><span class="m-foot">{activeK}/{TILE_N} active days</span></span>
			{/key}
		{:else}
			<div class="wmodal-head">
				<div class="wmodal-titles">
					<div class="wmodal-title">Activity</div>
					<div class="wmodal-sub">
						{trailing
							? 'Past 365 days — the current year is still incomplete'
							: `Calendar year ${year}`}
					</div>
				</div>
				<div class="wmodal-extra">
					<div class="ypick" role="group" aria-label="Year">
						<button class="ybtn" onclick={(e) => { e.stopPropagation(); step(-1); }} disabled={year <= minYear || phase !== 'settle'} aria-label="Previous year">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
						</button>
						<span class="yval" aria-live="polite">{yearLabel}</span>
						<button class="ybtn" onclick={(e) => { e.stopPropagation(); step(1); }} disabled={year >= currentYear || phase !== 'settle'} aria-label="Next year">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
						</button>
					</div>
				</div>
				<button class="wmodal-x" onclick={(e) => { e.stopPropagation(); hide(); }} aria-label="Close Activity">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
				</button>
			</div>
			<div class="wmodal-body" data-lenis-prevent>
				{#if !trailing && loading && yearDays.length === 0}
					<div class="xskel" aria-hidden="true">
						<div class="skel-row"></div>
						<div class="skel-row short"></div>
					</div>
				{:else if !trailing && loadError && yearDays.length === 0}
					<div class="empty">Couldn't load {year}. <button class="retry" onclick={() => void ensureYear(year)}>Retry</button></div>
				{:else if yearDays.length === 0}
					<div class="empty">No activity in this range yet.</div>
				{:else}
				{#key year}
						<div class="xstats" class:conceal={phase === 'fly'} class:leaving={phase === 'exit'}>
							<div class="xstat"><span class="xv num">{fmtTok(stats.total)}</span><span class="xl">tokens · {rangeLabel}</span></div>
							<div class="xstat"><span class="xv num">{stats.activeDays}</span><span class="xl">active days</span></div>
							<div class="xstat"><span class="xv num">{fmtTok(stats.peak)}</span><span class="xl">peak day</span></div>
							<div class="xstat"><span class="xv num">{stats.streak}d</span><span class="xl">streak</span></div>
						</div>
						<div class="xheat" class:pre={phase === 'fly'} class:leaving={phase === 'exit'} bind:this={heatEl}>
							<Heatmap days={yearDays} {highlightFrom} enterStagger={false} />
						</div>
						<p class="xnote" class:conceal={phase === 'fly'} class:leaving={phase === 'exit'}>
							{#if trailing}
								Ringed cells are the {TILE_N} days from the {variant} tile — close to fly them home.
							{:else}
								Calendar year {year} — closing returns without the flight, the tile days live in the current year.
							{/if}
						</p>
					{/key}
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	/* Grid slot this widget occupies (geometry formerly on button.widget). */
	.hwidget {
		width: 100%;
		min-width: 0;
	}
	.hwidget.sm {
		max-width: 300px;
		justify-self: center;
		width: 100%;
	}
	.hwidget.md {
		max-width: 360px;
		justify-self: center;
		width: 100%;
	}
	/* ---- shared container: tile resting state ---- */
	.morph.tile {
		cursor: pointer;
		display: flex;
		flex-direction: column;
		gap: 10px;
		width: 100%;
		text-align: left;
		font: inherit;
		color: var(--text);
		background: color-mix(in srgb, var(--bg-raised) 62%, transparent);
		backdrop-filter: blur(22px) saturate(1.6);
		-webkit-backdrop-filter: blur(22px) saturate(1.6);
		border-radius: 18px;
		padding: 16px 16px 13px;
		overflow: hidden;
		/* Same 4-part structure as the modal card (ring, top light,
		   drop, contact) at resting intensity — the morph interpolates
		   toward full modal elevation, so a shrinking card never wears a
		   full-size halo that winks out at unmount. */
		box-shadow:
			inset 0 0 0 1px var(--line),
			inset 0 1px 0 rgb(255 255 255 / 0.05),
			0 6px 18px rgb(0 0 0 / 0.07),
			0 1px 3px rgb(0 0 0 / 0.06);
		transition: transform 0.22s cubic-bezier(0.2, 0.9, 0.25, 1.2), box-shadow 0.22s ease;
	}
	.morph.tile:hover {
		transform: translateY(-2px) scale(1.008);
		box-shadow:
			inset 0 0 0 1px var(--line-strong),
			inset 0 1px 0 rgb(255 255 255 / 0.08),
			0 10px 30px rgb(0 0 0 / 0.1),
			0 2px 6px rgb(0 0 0 / 0.08);
	}
	.morph.tile:active {
		transform: translateY(0) scale(0.992);
	}
	.morph.tile:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.hwidget.sm .morph.tile {
		aspect-ratio: 1;
	}
	.hwidget.sm .morph.tile .mini,
	.hwidget.sm .tile-ghost .mini {
		flex: 1;
	}
	.hwidget.md .morph.tile .mini,
	.hwidget.md .tile-ghost .mini {
		flex: 1;
	}
	/* ---- shared container: modal resting state.
	   Transform-free centering (inset + auto margins) so GSAP owns x/y/scale. */
	.morph.modal {
		position: fixed;
		inset: 0;
		margin: auto;
		width: min(860px, calc(100vw - 40px));
		height: fit-content;
		max-height: min(86vh, 780px);
		z-index: 81;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		color: var(--text);
		background: color-mix(in srgb, var(--bg-raised) 78%, transparent);
		backdrop-filter: blur(28px) saturate(1.8);
		-webkit-backdrop-filter: blur(28px) saturate(1.8);
		border-radius: 20px;
		box-shadow:
			inset 0 0 0 1px var(--line-strong),
			0 30px 80px rgb(0 0 0 / 0.28),
			0 2px 8px rgb(0 0 0 / 0.12);
		transform-origin: center;
	}
	.wmodal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		background: light-dark(rgb(250 250 251 / 0.55), rgb(10 10 12 / 0.6));
		--wmodal-blur: 14px;
		backdrop-filter: blur(var(--wmodal-blur)) saturate(1.4);
		-webkit-backdrop-filter: blur(var(--wmodal-blur)) saturate(1.4);
	}
	/* Invisible replica holding the tile's grid slot + dot targets. */
	.tile-ghost {
		visibility: hidden;
		pointer-events: none;
		display: flex;
		flex-direction: column;
		gap: 10px;
		width: 100%;
		padding: 16px 16px 13px;
		border-radius: 18px;
		box-shadow:
			inset 0 0 0 1px var(--line),
			inset 0 1px 0 rgb(255 255 255 / 0.05),
			0 6px 18px rgb(0 0 0 / 0.07),
			0 1px 3px rgb(0 0 0 / 0.06);
		overflow: hidden;
	}
	.hwidget.sm .tile-ghost {
		aspect-ratio: 1;
	}
	.mini {
		display: grid;
		grid-template-columns: repeat(3, auto);
		gap: 12px;
		justify-content: center;
		align-content: center;
	}
	.mini.cols9 {
		grid-template-columns: repeat(9, auto);
		gap: 10px;
	}
	.mdot {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		background: var(--track);
		transition: background 0.4s ease, transform 0.18s ease;
		animation: dotpop 0.45s cubic-bezier(0.2, 0.9, 0.3, 1.3) backwards;
	}
	.cols9 .mdot {
		width: 18px;
		height: 18px;
	}
	.morph.tile .mdot:hover {
		transform: scale(1.25);
	}
	.lvl-1 { background: color-mix(in srgb, var(--heat) 35%, var(--track)); }
	.lvl-2 { background: color-mix(in srgb, var(--heat) 60%, var(--track)); }
	.lvl-3 { background: color-mix(in srgb, var(--heat) 82%, var(--track)); }
	.lvl-4 { background: var(--heat); }
	.mdot.live {
		animation: dotpop 0.45s cubic-bezier(0.2, 0.9, 0.3, 1.3) backwards, livepulse 2.4s ease-in-out 0.6s infinite;
	}
	@keyframes dotpop {
		from { transform: scale(0.2); opacity: 0; }
		to { transform: scale(1); opacity: 1; }
	}
	@keyframes livepulse {
		0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--heat) 55%, transparent); }
		50% { box-shadow: 0 0 0 6px transparent; }
	}
	.m-foot {
		font-variant-numeric: tabular-nums;
	}
	/* post-landing: tile remounted fresh — hold dots steady instead of
	   replaying their staggered entrance (the reload flicker) */
	.landed .mdot,
	.landed .mdot.live {
		animation: none;
	}
	/* year picker */
	.ypick {
		display: flex;
		align-items: center;
		gap: 4px;
		background: var(--track);
		border-radius: 999px;
		padding: 3px;
	}
	.yval {
		min-width: 118px;
		text-align: center;
		font-size: 12px;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
	}
	.ybtn {
		appearance: none;
		border: 0;
		background: transparent;
		color: var(--text-2);
		width: 26px;
		height: 26px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}
	.ybtn:hover:not(:disabled) {
		background: var(--accent-soft);
		color: var(--text);
	}
	.ybtn:disabled {
		opacity: 0.3;
		cursor: default;
	}
	/* ---- modal chrome ---- */
	.wmodal-head {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 18px 18px 12px;
	}
	.wmodal-titles {
		min-width: 0;
		flex: 1;
	}
	.wmodal-title {
		font-size: 15px;
		font-weight: 700;
		letter-spacing: -0.01em;
	}
	.wmodal-sub {
		margin-top: 2px;
		font-size: 12px;
		color: var(--text-3);
	}
	.wmodal-extra {
		display: flex;
		align-items: center;
		flex: none;
	}
	.wmodal-x {
		appearance: none;
		border: 0;
		background: transparent;
		color: var(--text-2);
		width: 30px;
		height: 30px;
		border-radius: 9px;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		flex: none;
	}
	.wmodal-x:hover {
		background: var(--accent-soft);
		color: var(--text);
	}
	.wmodal-body {
		padding: 4px 18px 20px;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
	}
	/* ---- tile chrome ---- */
	.w-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px;
	}
	.w-titles {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}
	.w-title {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-3);
	}
	.w-sub {
		font-size: 11px;
		color: var(--text-3);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.w-expand {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 7px;
		color: var(--text-3);
		flex: none;
		opacity: 0;
		transform: scale(0.8);
		transition: opacity 0.18s ease, transform 0.18s ease, background 0.18s ease;
	}
	.morph.tile:hover .w-expand,
	.morph.tile:focus-visible .w-expand {
		opacity: 1;
		transform: scale(1);
	}
	.w-foot {
		display: block;
		font-size: 10.5px;
		color: var(--text-3);
	}
	/* ---- flight concealment: layout reserved while flying, zero shifts ----
	   Pre-launch conceal covers the 1–2 frames before the timeline builds;
	   GSAP inline states take over seamlessly from there. */
	.conceal {
		visibility: hidden;
	}
	/* all cells hidden until the dots land (travelers included) */
	.xheat.pre :global(.heatmap .cell) {
		visibility: hidden;
	}
	/* card chrome hidden until the shell lands — squished scaling text
	   is the overlay tell */
	.conceal-head .wmodal-head > * {
		visibility: hidden;
	}
	/* backdrop invisible until the timeline's first tick owns it */
	.pre-show .wmodal-backdrop {
		opacity: 0;
	}
	.xstats {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 10px;
		margin: 6px 0 14px;
		transition: opacity 0.18s ease;
	}
	.xstat {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.xv {
		font-size: 19px;
		font-weight: 700;
		letter-spacing: -0.02em;
		line-height: 1.1;
	}
	.xl {
		font-size: 10.5px;
		color: var(--text-3);
	}
	.xheat {
		display: flex;
		justify-content: center;
		overflow-x: auto;
		padding-bottom: 4px;
		transition: opacity 0.18s ease;
	}
	.xnote {
		margin: 12px 2px 2px;
		font-size: 11.5px;
		color: var(--text-3);
		text-align: center;
		transition: opacity 0.18s ease;
	}
	/* exit dissolve (compositor-driven): everything but the travelers,
	   which the clones cover */
	.xstats.leaving,
	.xnote.leaving,
	.xheat.leaving {
		opacity: 0;
	}
	.xskel {
		display: grid;
		gap: 10px;
		padding: 12px 0;
	}
	.skel-row {
		height: 92px;
		border-radius: 10px;
		background: var(--track);
	}
	.skel-row.short {
		height: 20px;
		width: 45%;
		justify-self: center;
	}
	.empty {
		padding: 18px 0;
		text-align: center;
		font-size: 12.5px;
		color: var(--text-3);
	}
	.retry {
		appearance: none;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
	@media (max-width: 640px) {
		.morph.modal {
			width: calc(100vw - 24px);
			max-height: 92vh;
		}
		.mdot { width: 19px; height: 19px; }
		.cols9 .mdot { width: 16px; height: 16px; }
		.mini { gap: 10px; }
		.mini.cols9 { gap: 8px; }
		.xstats { grid-template-columns: repeat(2, 1fr); }
		.yval { min-width: 96px; }
	}
	@media (prefers-reduced-motion: reduce) {
		.morph.tile,
		.w-expand,
		.mdot, .mdot.live { animation: none; transition: none; }
		.morph.tile:hover {
			transform: none;
		}
	}
</style>
