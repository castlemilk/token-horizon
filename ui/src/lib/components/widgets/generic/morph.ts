// Shared-element geometry for widget ↔ modal morphs.
//
// Contract:
//   1. MEASURE everything first — start boxes and end boxes, live rects only.
//   2. Derive every tween value from those numbers (see flightVars/cardVars).
//   3. PLAY one timeline per direction.
//
// Nothing is hardcoded and nothing assumes centering, so the modal may sit
// anywhere (margins in % or px) and hold any amount of content: new extras
// just need measuring (if they travel) or relative from-states (if they
// fade in place). Reverse transitions re-measure at close time, which is
// what keeps resizes seamless.

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface DotPair {
	from: Box;
	to: Box;
	bg: string;
	/** Text travelers: the label plus its computed font, sampled at measure
	 *  time (open-flight sources are detached by spawn time, where
	 *  getComputedStyle goes silent). When present, the clone IS the text —
	 *  flown with the same x/y/scale flightVars — instead of a color dot.
	 *  Same string + same font at both ends makes the scale factor carry
	 *  the size change exactly; family/weight/style must agree, GSAP
	 *  cannot interpolate those. */
	text?: { value: string; css: string } | null;
}

/** Font + paint props that make a fresh <span> pixel-identical to the
 *  source's text. Returns null for non-text travelers (color cells),
 *  which keep the dot clone. */
export function sampleText(el: Element): { value: string; css: string } | null {
	const value = el.textContent?.trim();
	if (!value) return null;
	const cs = getComputedStyle(el);
	const css =
		`font-family:${cs.fontFamily};font-size:${cs.fontSize};` +
		`font-weight:${cs.fontWeight};font-style:${cs.fontStyle};` +
		`letter-spacing:${cs.letterSpacing};line-height:${cs.lineHeight};` +
		`font-variant-numeric:${cs.fontVariantNumeric};` +
		`white-space:${cs.whiteSpace};color:${cs.color};`;
	return { value, css };
}

export interface MorphPlan {
	/** Card current box → card resting box.
	 *  open: tile → modal; close: modal → tile. */
	cardFrom: Box;
	cardTo: Box;
	/** open: tile dot → year cell; close: year cell → tile dot. */
	dots: DotPair[];
}

/** Live rect, or null when missing/collapsed. Only viewport rects ever
 *  enter a plan — transforms in progress would poison them. */
export function boxOf(el: Element | null | undefined): Box | null {
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return r.width > 2 && r.height > 2 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
}

const cx = (b: Box) => b.x + b.w / 2;
const cy = (b: Box) => b.y + b.h / 2;

/** Translate + uniform scale about the center, carrying `from` onto `to`.
 *  Scale may grow or shrink — both are exact. */
export function flightVars(from: Box, to: Box): { x: number; y: number; scale: number } {
	return { x: cx(to) - cx(from), y: cy(to) - cy(from), scale: to.w / from.w };
}

/**
 * Overlap deltas between two boxes, center-origin.
 *
 * cardVars(A, B) spreads directly into a fromTo FROM-state to park an
 * element resting at B exactly over A (open: A=tile, B=card).
 * For a `to` tween landing on B, SWAP the args — cardVars(B, A) — since
 * `to` needs absolute end values, and the unswapped form inverts the
 * motion (collapse becomes blow-up). flightVars is already `to`-form.
 */
export function cardVars(from: Box, to: Box): { dx: number; dy: number; sx: number; sy: number } {
	return { dx: cx(from) - cx(to), dy: cy(from) - cy(to), sx: from.w / to.w, sy: from.h / to.h };
}

/**
 * Natural (untransformed) box from a live visual box + live GSAP offsets.
 * GSAP x/y/scale are relative to natural layout, while getBoundingClientRect
 * includes in-progress transforms — converging the two keeps closes during
 * an unfinished morph seamless instead of inverted (targets derived from a
 * half-scaled visual box point the wrong way: the card grows).
 * Identity offsets return the visual box unchanged.
 */
export function naturalBox(
	visual: Box,
	t: { x: number; y: number; scaleX: number; scaleY: number }
): Box {
	const sx = t.scaleX || 1;
	const sy = t.scaleY || 1;
	const w = visual.w / sx;
	const h = visual.h / sy;
	return {
		w,
		h,
		x: visual.x + visual.w / 2 - t.x - w / 2,
		y: visual.y + visual.h / 2 - t.y - h / 2
	};
}

let layer: HTMLDivElement | null = null;

export function removeClones() {
	layer?.remove();
	layer = null;
}

/** Body-level clones parked exactly over each pair's `from` box.
 *  Body-level (never inside blurred/filtered ancestors) keeps viewport
 *  coords exact under any modal margin or placement. Text pairs clone
 *  the label itself (font sampled at measure time); color pairs keep
 *  the solid-dot clone. */
export function spawnClones(pairs: DotPair[]): HTMLSpanElement[] {
	removeClones();
	layer = document.createElement('div');
	layer.setAttribute('aria-hidden', 'true');
	layer.style.cssText =
		'position:fixed;inset:0;z-index:200;pointer-events:none;margin:0;padding:0;';
	const clones = pairs.map((p) => {
		const d = document.createElement('span');
		const base =
			`position:fixed;left:${p.from.x}px;top:${p.from.y}px;` +
			`margin:0;padding:0;transform-origin:center;`;
		if (p.text) {
			// Natural sizing: same text + same font reproduces the source
			// box, so flightVars' center-based scale lands exactly on `to`.
			d.style.cssText = base + p.text.css + 'background:transparent;';
			d.textContent = p.text.value;
		} else {
			d.style.cssText =
				base +
				`width:${p.from.w}px;height:${p.from.h}px;border-radius:50%;` +
				`background:${p.bg};`;
		}
		layer!.appendChild(d);
		return d;
	});
	document.body.appendChild(layer);
	return clones;
}

/** Resolve when an element's rect holds still (auto-fitting content,
 *  fonts settling). Guarantees measured end boxes are final. */
export function rectSettled(el: () => Element | null, maxFrames = 12): Promise<void> {
	return new Promise((resolve) => {
		let last = '';
		let steady = 0;
		let n = 0;
		const sample = () => {
			n++;
			const r = el()?.getBoundingClientRect();
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
