/**
 * Motion handling for seat-pricing. Every check calls calmPage after its fresh load.
 *
 * The kit's freezeMotion sets animation:none, which returns an entrance animation
 * (opacity 0 at rest, animated to 1 with fill-mode forwards) to its opacity-0 base
 * state, so content would look missing. This file instead:
 *   - stops transitions and smooth scrolling only (transition:none, scroll-behaviour
 *     auto), so a conforming page with an ordinary CSS transition reads its final
 *     values in the same turn;
 *   - finishes every running Web Animation, so entrance animations show their end
 *     state and CSS animations started by an action are complete before it is read.
 *
 * revealAll scrolls the document top to bottom in viewport steps (one frame per step) so that
 * reveal-on-scroll content (IntersectionObserver classes) is shown before the
 * contrast audit reads it, then returns to the top.
 */
import type { Page } from 'playwright'
import { finishAnimations, probe } from '../../lib/probe'

const FREEZE_TRANSITIONS = String.raw`() => {
  if (document.getElementById('__seat_pricing_calm')) return false;
  var style = document.createElement('style');
  style.id = '__seat_pricing_calm';
  style.textContent = '*,*::before,*::after{transition:none !important;scroll-behavior:auto !important}';
  (document.head || document.documentElement).appendChild(style);
  return true;
}`

const REVEAL_ALL = String.raw`async () => {
  // One animation frame after each scroll: an IntersectionObserver reports in the frame that follows a scroll.
  // The positions are one viewport apart (so every line is in view at some position) and include the last one.
  function frame() {
    return new Promise(function (resolve) { requestAnimationFrame(function () { resolve(true); }); });
  }
  var step = Math.max(200, window.innerHeight);
  var end = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  var positions = [];
  for (var y = 0; y < end && positions.length < 60; y += step) positions.push(y);
  positions.push(end);
  for (var i = 0; i < positions.length; i++) {
    window.scrollTo({ left: 0, top: positions[i], behavior: 'instant' });
    await frame();
  }
  window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
  await frame();
  return positions.length;
}`

/** Once per document: stop transitions and smooth scrolling, then finish running animations. */
export async function calmPage(page: Page): Promise<void> {
  await probe(page, FREEZE_TRANSITIONS, undefined, 1500).catch(() => false)
  await finishAnimations(page)
}

/** Scroll the whole document through once so reveal-on-scroll content is shown, then finish animations. */
export async function revealAll(page: Page): Promise<number> {
  const steps = await probe<number>(page, REVEAL_ALL, undefined, 2500)
  await finishAnimations(page)
  return steps
}
