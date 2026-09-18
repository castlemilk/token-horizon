<script lang="ts">
	import { tick } from 'svelte';
	import type { Snippet } from 'svelte';
	import gsap from 'gsap';
	import {
		boxOf,
		naturalBox,
		flightVars,
		cardVars,
		sampleText,
		sampleVisual,
		spawnClones,
		removeClones,
		type Box,
		type DotPair
	} from './morph';

	/** One shared container that IS the tile when closed and the modal
	 *  when open. Widgets supply content snippets plus the travel pairing;
	 *  the shell owns every pixel of the choreography:
	 *  measure → plan → play, one GSAP timeline per direction (geometry in
	 *  ./morph.ts, everything measured live, never assumed).
	 *
	 *  Content awareness is declarative. The widget tags nothing; instead
	 *  it passes small specs evaluated against the live card at flight
	 *  time, so new content joins the cascade by joining a list:
	 *  - enterOpen: post-landing entrances (kind + position on the timeline)
	 *  - exitClose: dissolve targets for the return flight
	 *  Modal chrome (header/close) and the backdrop are shell-owned and
	 *  handled internally. Travelers are paired by the widget's
	 *  `travelFrom`/`travelTo` (source ↔ target elements, zipped by
	 *  index); the shell boxes them and flies clones between them —
	 *  verbatim text clones for labeled travelers (same font both ends,
	 *  scale carries the size change), color dots for the rest.
	 *
	 *  `speed` scales every duration (1 = brisk). `phase`/`landed` are
	 *  bindable so content can gate on them (year stepping, landing
	 *  fades) without reaching into the engine. */

	export type Phase = 'fly' | 'settle' | 'exit';

	export interface FlightCtx {
		/** Travelers' landing time: clones home by here. */
		landT: number;
		/** Container morph duration end. */
		mEnd: number;
		/** 1 / speed. */
		S: number;
	}

	export interface EnterSpec {
		select: string;
		kind: 'ripple' | 'rise' | 'fade';
		/** Skip elements that are travel targets (travelers ride clones). */
		excludeTravel?: boolean;
		at: (c: FlightCtx) => number;
		/** Rise offset (rise only). */
		y?: number;
		/** Override duration (rise/fade). */
		dur?: number;
	}

	export interface ExitSpec {
		select: string;
		dur?: number;
		at?: (c: { S: number }) => number;
	}

	export interface TravelRoots {
		box: HTMLElement | null;
		ghost: HTMLElement | null;
	}

	/** A travel endpoint: stable key + live element. Shell matches
	 *  from↔to by key, so tile and modal orderings may differ. */
	export interface TravelMark {
		key: string;
		el: Element | null;
	}

	/** One box-shadow layer as numbers: lengths interpolate, then divide
	 *  by the live scale each frame; color held constant (tile side). */
	interface ShadowLayer {
		inset: boolean;
		color: string;
		v: [number, number, number, number];
	}

	function splitShadowLayers(s: string): string[] {
		const out: string[] = [];
		let depth = 0;
		let cur = '';
		for (const ch of s) {
			if (ch === '(') depth++;
			if (ch === ')') depth--;
			if (ch === ',' && depth === 0) {
				out.push(cur);
				cur = '';
			} else cur += ch;
		}
		if (cur.trim()) out.push(cur);
		return out;
	}

	function parseShadow(s: string): ShadowLayer[] | null {
		if (!s || s === 'none') return null;
		const parsed: ShadowLayer[] = [];
		for (const layer of splitShadowLayers(s)) {
			const nums = (layer.match(/-?\d*\.?\d+px/g) ?? []).map((n) => parseFloat(n));
			if (nums.length < 3) return null;
			const color = layer
				.replace(/-?\d*\.?\d+px/g, '')
				.replace(/inset/g, '')
				.replace(/\s+/g, ' ')
				.trim();
			parsed.push({
				inset: layer.includes('inset'),
				color,
				v: [nums[0], nums[1], nums[2], nums[3] ?? 0]
			});
		}
		return parsed;
	}

	function parseLensPair(
		tileStr: string,
		modalStr: string
	): { tile: ShadowLayer[]; modal: ShadowLayer[] } | null {
		const tile = parseShadow(tileStr);
		const modal = parseShadow(modalStr);
		if (!tile || !modal || tile.length !== modal.length || tile.length === 0) return null;
		return { tile, modal };
	}

	const NUM_RE = /-?\d*\.?\d+/g;

	/** Interpolate two computed colors channel-wise. Shapes must match
	 *  (same function + units); otherwise null → caller holds its side. */
	function lerpColor(a: string, b: string, t: number): string | null {
		const na = a.match(NUM_RE) ?? [];
		const nb = b.match(NUM_RE) ?? [];
		if (na.length === 0 || na.length !== nb.length) return null;
		if (a.replace(NUM_RE, '#') !== b.replace(NUM_RE, '#')) return null;
		let i = 0;
		return a.replace(NUM_RE, () => {
			const v = parseFloat(na[i]) + (parseFloat(nb[i]) - parseFloat(na[i])) * t;
			i++;
			return String(Math.round(v * 1000) / 1000);
		});
	}

	function projScale(el: HTMLElement): { sx: number; sy: number } {
		return {
			sx: Number(gsap.getProperty(el, 'scaleX')) || 1,
			sy: Number(gsap.getProperty(el, 'scaleY')) || 1
		};
	}

	/**
	 * Scale-compensated shadow: the card's transform multiplies whatever
	 * shadow value is set, so the interpolated lengths are divided by the
	 * live scale — the PAINTED shadow tracks the tile↔modal curve exactly
	 * instead of double-shrinking. x/y divide by their own axis (the
	 * morph is non-uniform), blur/spread by the mean. Colors interpolate
	 * channel-wise too, so the handoff back to CSS is exact everywhere.
	 */
	function shadowCSS(
		fromV: ShadowLayer[],
		toV: ShadowLayer[],
		t: number,
		sx: number,
		sy: number
	): string {
		const kx = Math.max(sx, 0.001);
		const ky = Math.max(sy, 0.001);
		const kb = Math.max((sx + sy) / 2, 0.001);
		const r2 = (n: number) => String(Math.round(n * 100) / 100);
		return toV
			.map((L, i) => {
				const F = fromV[i];
				const x = (F.v[0] + (L.v[0] - F.v[0]) * t) / kx;
				const y = (F.v[1] + (L.v[1] - F.v[1]) * t) / ky;
				const b = (F.v[2] + (L.v[2] - F.v[2]) * t) / kb;
				const s = (F.v[3] + (L.v[3] - F.v[3]) * t) / kb;
				const color = lerpColor(F.color, L.color, t) ?? F.color;
				return `${L.inset ? 'inset ' : ''}${r2(x)}px ${r2(y)}px ${r2(b)}px ${r2(s)}px ${color}`;
			})
			.join(', ');
	}

	let {
		size,
		speed = 1,
		tileLabel,
		title,
		headerExtra,
		tile,
		modalBody,
		ghostBody,
		phase = $bindable('settle'),
		landed = $bindable(false),		canFly,
		closeable,
		travelFrom,
		travelTo,
		awaitSettled,
		staggerOpen,
		staggerClose,
		enterOpen = [],
		exitClose = []
	}: {
		size: 'sm' | 'md';
		speed?: number;
		tileLabel: string;
		title: string;
		headerExtra?: Snippet;
		tile: Snippet;
		modalBody: Snippet;
		ghostBody: Snippet;
		phase?: Phase;
		landed?: boolean;
		/** Flight possible (data ready, motion allowed)? */
		canFly: () => boolean;
		/** Return flight maps home (trailing content the tile can
		 *  claim)? False → plain fade, never a fake flight. */
		closeable: () => boolean;
		/** Travel endpoints, measured live, matched by key. Split in two
		 *  because open mounts its targets after the sources are gone:
		 *  `travelFrom` reads sources pre-swap, `travelTo` reads targets
		 *  post-mount (open) or live (close). Missing keys fall back to
		 *  a plain fade, never a half flight. */
		travelFrom: (dir: 'open' | 'close', roots: TravelRoots) => TravelMark[] | null;
		travelTo: (dir: 'open' | 'close', roots: TravelRoots) => TravelMark[] | null;
		/** Resolve when post-mount layout holds still (heat rect steady). */
		awaitSettled: () => Promise<void>;
		/** Per-traveler stagger, open/close, at speed 1. */
		staggerOpen: number;
		staggerClose: number;
		enterOpen?: EnterSpec[];
		exitClose?: ExitSpec[];
	} = $props();

	const S = $derived(1 / (speed > 0 ? speed : 1));
	const STAG = $derived(staggerOpen / (speed > 0 ? speed : 1));
	const BSTAG = $derived(staggerClose / (speed > 0 ? speed : 1));
	const reduce =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	let open = $state(false);
	/** THE shared container: tile when closed, modal when open. Never recreated. */
	let boxEl = $state<HTMLElement | null>(null);
	let ghostEl = $state<HTMLElement | null>(null);
	let backdropEl = $state<HTMLElement | null>(null);
	/** Flipped the frame the timeline takes over the backdrop. */
	let started = $state(false);
	let activeTl: gsap.core.Timeline | null = null;
	let timers: number[] = [];
	/** Invalidates a pending open flight scheduled via tick(). */
	let flightId = 0;
	/** Tile-side measurements taken while boxEl still IS the tile.
	 *  Boxes + colors + text + resting shadow are captured pre-swap: after
	 *  the swap the tile nodes are detached and measure void. */
	let pendingTile: {
		tileBox: Box;
		dots: { key: string; box: Box; bg: string; text: DotPair['text']; visual: DotPair['visual'] }[];
		tileShadow: string;
	} | null = null;

	/** Box one side's marks; null when any endpoint is missing. */
	function boxMarks(marks: TravelMark[]): { key: string; box: Box; el: Element }[] | null {
		const out: { key: string; box: Box; el: Element }[] = [];
		for (const m of marks) {
			if (!m.el) return null;
			const box = boxOf(m.el);
			if (!box) return null;
			out.push({ key: m.key, box, el: m.el });
		}
		return out;
	}

	/** ?morphdebug=1 logs flight decisions (pairing bail reasons) — set in
	 *  either shell to compare Tauri vs browser behavior. */
	function morphDebug(): boolean {
		try {
			return new URLSearchParams(location.search).has('morphdebug');
		} catch {
			return false;
		}
	}
	function mdbg(...a: unknown[]) {
		if (morphDebug()) console.info('[morph]', ...a);
	}

	/** ?slowmo=1 slows every widget timeline — landing-frame inspection. */
	function slowmo(tl: gsap.core.Timeline): gsap.core.Timeline {
		try {
			if (new URLSearchParams(location.search).has('slowmo')) tl.timeScale(0.25);
		} catch {
			/* non-browser prerender */
		}
		return tl;
	}

	function clearTimers() {
		for (const t of timers) clearTimeout(t);
		timers = [];
	}

	function killTl() {
		activeTl?.kill();
		activeTl = null;
	}

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
		started = false;
		pendingTile = null;
		phase = 'settle';
		if (wasExit) {
			// Tile remounts fresh below: hold dots steady from first
			// paint. Stays set until the next open (show clears it as
			// the tile unmounts) — clearing it on a timer would replay
			// the entrance and flicker the whole widget.
			landed = true;
			// Single landing event: geometry, shadow, dots and content
			// all agree in the swap tick — transitions frozen so nothing
			// re-animates after it. Restored once settled.
			if (boxEl) gsap.set(boxEl, { transition: 'none' });
			timers.push(
				window.setTimeout(() => {
					if (boxEl) gsap.set(boxEl, { clearProps: 'transition' });
				}, 60)
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
				if (backdropEl) gsap.set(backdropEl, { clearProps: 'all' });
				phase = 'settle';
			}
			return;
		}
		killTl();
		clearTimers();
		landed = false;
		if (boxEl) gsap.set(boxEl, { clearProps: 'all' });
		if (!canFly()) {
			mdbg('open: no flight (canFly false)');
			phase = 'settle';
			open = true;
			return;
		}
		// Measure while boxEl still IS the tile — after the swap the tile
		// content is gone. Scoped to boxEl: the ghost replica (same
		// markup) isn't mounted yet while closed.
		const tileBox = boxOf(boxEl);
		const marks = travelFrom('open', { box: boxEl, ghost: null }) ?? [];
		const fromBoxed = boxMarks(marks);
		if (!tileBox || !boxEl || !fromBoxed || fromBoxed.length === 0) {
			mdbg('open: no flight (tile measure fail)', {
				tileBox,
				marks: marks.map((m) => m.key),
				fromBoxed: fromBoxed?.map((d) => d.key) ?? null
			});
			phase = 'settle';
			open = true;
			return;
		}
		// Clone paint is sampled from the SOURCE (computed style) — pixel-
		// identical travelers under any theme; text is cloned verbatim.
		pendingTile = {
			tileBox,
			dots: fromBoxed.map((d) => ({
				key: d.key,
				box: d.box,
				bg: getComputedStyle(d.el).backgroundColor,
				text: sampleText(d.el),
				visual: sampleVisual(d.el)
			})),
			tileShadow: getComputedStyle(boxEl).boxShadow
		};
		phase = 'fly';
		open = true;
		const id = ++flightId;
		void tick().then(async () => {
			if (id !== flightId) return;
			await awaitSettled();
			if (id !== flightId) return;
			launchOpen(id);
		});
	}

	/**
	 * OPEN — boxEl (the tile itself) has swapped to its modal layout;
	 * park it over the stored tile box, then play one timeline: the
	 * container expands while travelers ride clones to their targets,
	 * then extras cascade in per spec.
	 */
	function launchOpen(id: number) {
		if (id !== flightId) return;
		if (!open || phase !== 'fly' || !boxEl || !pendingTile) {
			mdbg('open: launch aborted', { open, phase, boxEl: !!boxEl, pendingTile: !!pendingTile });
			if (open && id === flightId) phase = 'settle';
			return;
		}
		const card = boxEl;
		const cardBox = boxOf(card);
		const toMarks = travelTo('open', { box: card, ghost: null }) ?? [];
		const toBoxed = boxMarks(toMarks);
		if (!cardBox || !toBoxed || toBoxed.length === 0) {
			mdbg('open: no flight (modal measure fail)', {
				cardBox,
				toMarks: toMarks.map((m) => m.key),
				toBoxed: toBoxed?.map((t) => t.key) ?? null
			});
			phase = 'settle';
			return;
		}
		const targets = new Map(toBoxed.map((t) => [t.key, t] as const));
		const pairs: DotPair[] = [];
		for (const d of pendingTile.dots) {
			const t = targets.get(d.key);
			if (!t) {
				mdbg('open: no flight (key miss)', { missing: d.key, targets: [...targets.keys()] });
				phase = 'settle';
				return;
			}
			pairs.push({ from: d.box, to: t.box, bg: d.bg, text: d.text, visual: d.visual });
		}
		mdbg('open: flight', {
			pairs: pairs.map((p) => `${p.from.w.toFixed(0)}→${p.to.w.toFixed(0)}`),
			clones: pairs.map((p) => (p.text ? 'text' : p.visual ? 'visual' : 'dot'))
		});
		const clones = spawnClones(pairs);
		const landT = 0.06 + (pairs.length - 1) * STAG + 0.45 * S;
		const mEnd = 0.38 * S;

		const tl = slowmo(gsap.timeline({ defaults: { ease: 'power3.out' } }));
		activeTl = tl;
		started = true;

		// Backdrop ramps with everything else: dim + blur rise together.
		// Read the resting look BEFORE parking it transparent.
		const backdrop = backdropEl;
		const backdropBg = backdrop ? getComputedStyle(backdrop).backgroundColor : 'rgba(0,0,0,0)';
		if (backdrop) {
			gsap.set(backdrop, {
				backgroundColor: 'rgba(0,0,0,0)',
				'--wmodal-blur': '0px',
				'--wmodal-sat': '1'
			});
			tl.to(
				backdrop,
				{
					backgroundColor: backdropBg,
					'--wmodal-blur': '14px',
					'--wmodal-sat': '1.4',
					duration: 0.45 * S,
					ease: 'power1.out'
				},
				0
			);
		}

		// 1 — container + travelers move together, all values precomputed.
		// The shadow rides the compensated driver so the painted result
		// tracks the tile→modal curve exactly (at t=0 it matches the
		// just-unmounted tile pixel-for-pixel).
		const lens = parseLensPair(pendingTile.tileShadow, getComputedStyle(card).boxShadow);
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
			{ x: cv.dx, y: cv.dy, scaleX: cv.sx, scaleY: cv.sy },
			{
				x: 0,
				y: 0,
				scaleX: 1,
				scaleY: 1,
				transformOrigin: '50% 50%',
				duration: mDur,
				ease: 'power3.inOut'
			},
			0
		);
		tl.to(rc, { r: 20, duration: mDur, ease: 'power3.inOut', onUpdate: applyRadius }, 0);
		applyRadius(); // settle corners synchronously — no one-frame pinch
		if (lens) {
			const shop = { t: 0 };
			const applyShadow = () => {
				const { sx, sy } = projScale(card);
				card.style.boxShadow = shadowCSS(lens.tile, lens.modal, shop.t, sx, sy);
			};
			applyShadow();
			tl.to(shop, { t: 1, duration: mDur, ease: 'power3.inOut', onUpdate: applyShadow }, 0);
		}
		clones.forEach((c, i) => {
			const f = flightVars(pairs[i].from, pairs[i].to);
			tl.to(
				c,
				{ x: f.x, y: f.y, scale: f.scale, duration: 0.45 * S, ease: 'power3.out' },
				0.06 * S + i * STAG
			);
		});
		tl.to(clones, { autoAlpha: 0, duration: 0.15 * S, ease: 'power1.out' }, landT);

		// 2 — extras cascade in behind the landing, per spec.
		const ctx: FlightCtx = { landT, mEnd, S };
		const travelTargets = new Set(toBoxed.map((t) => t.el));
		for (const spec of enterOpen) {
			const els = [...card.querySelectorAll(spec.select)].filter(
				(el) => !(spec.excludeTravel && travelTargets.has(el))
			);
			if (els.length === 0) continue;
			const at = spec.at(ctx);
			if (spec.kind === 'ripple') {
				tl.fromTo(
					els,
					{ scale: 0, autoAlpha: 0 },
					{
						scale: 1,
						autoAlpha: 1,
						duration: 0.35 * S,
						ease: 'back.out(1.6)',
						stagger: { amount: 0.5 * S, from: 'end', grid: 'auto' }
					},
					at
				);
			} else if (spec.kind === 'rise') {
				tl.from(
					els,
					{
						y: spec.y ?? 12,
						autoAlpha: 0,
						duration: (spec.dur ?? 0.3) * S,
						ease: 'power3.out',
						stagger: 0.06 * S
					},
					at
				);
			} else {
				tl.fromTo(
					els,
					{ autoAlpha: 0 },
					{ autoAlpha: 1, duration: (spec.dur ?? 0.25) * S, ease: 'power1.out' },
					at
				);
			}
		}
		// Card chrome stays hidden while the shell scales — visible
		// squished text is the overlay tell — then fades in once landed.
		const head = card.querySelectorAll('.wmodal-head > *');
		if (head.length > 0) {
			tl.fromTo(head, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25 * S, ease: 'power1.out' }, mEnd);
		}
		tl.call(
			() => {
				removeClones();
				// Flight tweens are done: hand transform/radius/shadow back
				// to CSS (values are identical, so this paints nothing) and
				// the settled modal stays live to theme changes instead of
				// wearing stale inline props.
				gsap.set(card, { clearProps: 'transform,boxShadow,borderRadius,transformOrigin' });
			},
			[],
			landT + 0.3
		);
		timers.push(
			window.setTimeout(() => {
				if (open && phase === 'fly') phase = 'settle';
			}, landT * 1000)
		);
	}

	/**
	 * CLOSE — the same container collapses back into the tile: chrome and
	 * spec'd extras dissolve, travelers fly home to the ghost replica, the
	 * backdrop fades on the SAME timeline, and only then does the node
	 * drop back to tile flow.
	 *
	 * Runs from ANY choreography phase, even mid-flight: the open timeline
	 * is killed first and GSAP's inline leftovers are scrubbed off every
	 * node the exit doesn't tween. The card itself is left alone so a
	 * mid-morph collapse continues smoothly instead of snapping.
	 */
	function hide() {
		if (!open || phase === 'exit') return;
		if (reduce || !closeable()) {
			mdbg('close: plain fade', { reduce, closeable: closeable() });
			// Motion-safe, or content the tile can't map home: plain
			// fade, never a fake flight — backdrop included.
			killTl();
			clearTimers();
			const card = boxEl;
			const backdrop = backdropEl;
			if (card && backdrop && !reduce) {
				phase = 'exit';
				const ftl = slowmo(gsap.timeline({ onComplete: () => reset() }));
				activeTl = ftl;
				ftl.to([card, backdrop], { autoAlpha: 0, duration: 0.18 * S, ease: 'power1.out' }, 0);
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
			for (const spec of [...enterOpen, ...exitClose]) {
				gsap.set(card.querySelectorAll(spec.select), { clearProps: 'all' });
			}
			// A killed landing may have stranded opacity/transition states.
			gsap.set(card, { clearProps: 'opacity,visibility,transition' });
		}
		if (!card || !ghost) {
			mdbg('close: no flight (no card/ghost)');
			reset();
			return;
		}
		const fromMarks = travelFrom('close', { box: card, ghost }) ?? [];
		const toMarks = travelTo('close', { box: card, ghost }) ?? [];
		const modalBox = boxOf(card);
		const tileBox = boxOf(ghost);
		const fromBoxed = boxMarks(fromMarks);
		const toBoxed = boxMarks(toMarks);
		if (!modalBox || !tileBox || !fromBoxed || !toBoxed || fromBoxed.length === 0) {
			mdbg('close: no flight (measure fail)', {
				modalBox,
				tileBox,
				from: fromBoxed?.map((d) => d.key) ?? null,
				to: toBoxed?.map((d) => d.key) ?? null
			});
			reset();
			return;
		}
		const targets = new Map(toBoxed.map((t) => [t.key, t] as const));
		const pairs: DotPair[] = [];
		for (const f of fromBoxed) {
			const t = targets.get(f.key);
			if (!t) {
				mdbg('close: no flight (key miss)', { missing: f.key, targets: [...targets.keys()] });
				reset();
				return;
			}
			pairs.push({
				from: f.box,
				to: t.box,
				bg: getComputedStyle(f.el).backgroundColor,
				text: sampleText(f.el),
				visual: sampleVisual(f.el)
			});
		}
		phase = 'exit';
		mdbg('close: flight', {
			pairs: pairs.map((p) => `${p.from.w.toFixed(0)}→${p.to.w.toFixed(0)}`),
			clones: pairs.map((p) => (p.text ? 'text' : p.visual ? 'visual' : 'dot'))
		});
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
		// and the unswapped form inverts the collapse into a blow-up.
		// The shadow rides the compensated driver (modal→tile) so no dark
		// halo lingers into the landing; the reset freeze absorbs the handoff.
		const cv = cardVars(tileBox, naturalBox(modalBox, liveT));
		const lens = parseLensPair(
			getComputedStyle(ghost).boxShadow,
			getComputedStyle(card).boxShadow
		);
		// Beat 1 dissolves chrome + spec'd extras; beat 2 moves container
		// + travelers home while the backdrop releases on the same timeline.
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
					// Geometry, radius and shadow all agree with the tile
					// exactly: swap + scrub in one tick.
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
				xBase + i * BSTAG
			);
		});
		// Header dissolves with the rest — lingering chrome over a
		// collapsing shell reads as overlay, not morph.
		const headEls = card.querySelectorAll('.wmodal-head > *');
		if (headEls.length > 0) {
			xtl.to(headEls, { autoAlpha: 0, duration: 0.22 * S, ease: 'power1.out' }, 0);
		}
		for (const spec of exitClose) {
			const els = card.querySelectorAll(spec.select);
			if (els.length === 0) continue;
			xtl.to(
				els,
				{ autoAlpha: 0, duration: (spec.dur ?? 0.28) * S, ease: 'power1.out' },
				spec.at ? spec.at({ S }) : 0.08 * S
			);
		}
		// Collapse eases IN (accelerating): dwell time lives at full size
		// where everything paints sharp, and the extreme minification —
		// where raster downsampling softens the 1px borders — passes
		// quickly into the exact swap. inOut would dwell longest exactly
		// where it looks softest. Travelers keep their own decelerating
		// ease; shadow/radius drivers stay locked to the card ease.
		const COLLAPSE_EASE = 'power3.in';
		xtl.to(
			card,
			{
				x: cv.dx,
				y: cv.dy,
				scaleX: cv.sx,
				scaleY: cv.sy,
				transformOrigin: '50% 50%',
				duration: xDur,
				ease: COLLAPSE_EASE
			},
			xBase
		);
		xtl.to(xrc, { r: 18, duration: xDur, ease: COLLAPSE_EASE, onUpdate: xApplyRadius }, xBase);
		if (lens) {
			const shx = { t: 0 };
			const applyXShadow = () => {
				const { sx, sy } = projScale(card);
				card.style.boxShadow = shadowCSS(lens.modal, lens.tile, shx.t, sx, sy);
			};
			applyXShadow();
			xtl.to(shx, { t: 1, duration: xDur, ease: COLLAPSE_EASE, onUpdate: applyXShadow }, xBase);
		}
		// The dim + blur release WITH the collapse — fading only after
		// unmount would never visibly fade.
		const backdrop = backdropEl;
		if (backdrop) {
			xtl.to(
				backdrop,
				{
					backgroundColor: 'rgba(0,0,0,0)',
					'--wmodal-blur': '0px',
					'--wmodal-sat': '1',
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
	class:sm={size === 'sm'}
	class:md={size === 'md'}
	class:pre-show={phase === 'fly' && !started}
>
	{#if open}
		<!-- Invisible replica: holds the grid slot while the shared
		     container is fixed as the modal, and supplies the measured
		     tile + traveler targets for the return flight. Inner markup
		     must match the tile exactly (single-source snippets). -->
		<div class="tile-ghost" bind:this={ghostEl} aria-hidden="true">
			{@render ghostBody()}
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
		class:conceal-exit={open && phase === 'exit'}
		role={open ? 'dialog' : 'button'}
		aria-modal={open ? 'true' : undefined}
		aria-label={open ? title : tileLabel}
		tabindex={open ? undefined : 0}
		onclick={() => {
			if (!open) show();
		}}
		onkeydown={onTileKey}
	>
		{#if !open}
			{@render tile()}
		{:else}
			<div class="wmodal-head">
				{#if headerExtra}{@render headerExtra()}{/if}
				<button class="wmodal-x" onclick={(e) => { e.stopPropagation(); hide(); }} aria-label="Close {title}">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
				</button>
			</div>
			<div class="wmodal-body" data-lenis-prevent>
				{@render modalBody()}
			</div>
		{/if}
	</div>
</div>

<style>
	/* Grid slot this widget occupies. */
	.hwidget {
		width: 100%;
		min-width: 0;
	}
	.hwidget.sm {
		max-width: 200px;
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
		padding: 26px 16px;
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
		transition: transform 0.22s cubic-bezier(0.2, 0.9, 0.25, 1.2);
	}
	.morph.tile:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	/* ---- shared container: modal resting state.
	   Transform-free centering (inset + auto margins) so GSAP owns x/y/scale. */
	.morph.modal {
		position: fixed;
		inset: 0;
		margin: min(15vh, 60px) auto;
		width: min(860px, calc(100vw - 40px));
		height: fit-content;
		max-height: min(calc(100vh - 2 * min(15vh, 60px)), 780px);
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
			inset 0 1px 0 rgb(255 255 255 / 0.08),
			0 30px 80px rgb(0 0 0 / 0.28),
			0 2px 8px rgb(0 0 0 / 0.12);
		transform-origin: center;
		/* No shadow transition here: the flight driver writes the shadow
		   every frame, and a CSS transition underneath would lag each
		   write into a smearing echo. Frosted properties (backdrop-filter,
		   background) are likewise transition-free: they swap in the same
		   busy frame as the content, where a crossfade would only draw a
		   second motion event after landing. */
	}
	.wmodal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		background: light-dark(rgb(250 250 251 / 0.55), rgb(10 10 12 / 0.6));
		--wmodal-blur: 14px;
		--wmodal-sat: 1.4;
		backdrop-filter: blur(var(--wmodal-blur)) saturate(var(--wmodal-sat));
		-webkit-backdrop-filter: blur(var(--wmodal-blur)) saturate(var(--wmodal-sat));
	}
	/* Invisible replica holding the tile's grid slot + traveler targets. */
	.tile-ghost {
		visibility: hidden;
		pointer-events: none;
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 10px;
		width: 100%;
		padding: 26px 16px;
		border-radius: 18px;
		box-shadow:
			inset 0 0 0 1px var(--line),
			inset 0 1px 0 rgb(255 255 255 / 0.05),
			0 6px 18px rgb(0 0 0 / 0.07),
			0 1px 3px rgb(0 0 0 / 0.06);
		overflow: hidden;
	}
	.hwidget.sm .morph.tile,
	.hwidget.sm .tile-ghost {
		aspect-ratio: 1;
	}
	.hwidget.md .morph.tile,
	.hwidget.md .tile-ghost {
		min-height: 200px;
	}
	/* ---- modal chrome (shell-owned) ---- */
	.wmodal-head {
		display: flex;
		align-items: center;
		justify-content: center;
		position: relative;
		gap: 12px;
		padding: 16px 18px 10px;
		/* The X is absolutely positioned, so it contributes no height: with
		   no headerExtra the strip would collapse to its 26px padding and the
		   30px button would center past the card's top edge (clipped by
		   overflow:hidden). Reserve room for the button either way. */
		min-height: 52px;
	}
	.wmodal-x {
		appearance: none;
		border: 0;
		background: transparent;
		color: var(--text-2);
		width: 38px;
		height: 38px;
		border-radius: 12px;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		flex: none;
		position: absolute;
		right: 12px;
		top: 50%;
		transform: translateY(-50%);
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
		/* soft edge fades so scrolled content (e.g. the chart)
		   dissolves instead of clipping hard at the frame */
		-webkit-mask-image: linear-gradient(
			to bottom,
			transparent 0,
			#000 48px,
			#000 calc(100% - 40px),
			transparent 100%
		);
		mask-image: linear-gradient(
			to bottom,
			transparent 0,
			#000 48px,
			#000 calc(100% - 40px),
			transparent 100%
		);
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
	/* The open flight must mount the modal at resting size to measure
	   it, but that shell must never paint: hold it hidden until the
	   timeline parks it over the tile. visibility keeps layout intact,
	   so measuring still works. */
	.pre-show .morph.modal {
		visibility: hidden;
	}
	@media (max-width: 640px) {
		.morph.modal {
			width: calc(100vw - 24px);
			max-height: calc(100vh - 2 * min(15vh, 60px));
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.morph.tile {
			animation: none;
			transition: none;
		}
	}
</style>
