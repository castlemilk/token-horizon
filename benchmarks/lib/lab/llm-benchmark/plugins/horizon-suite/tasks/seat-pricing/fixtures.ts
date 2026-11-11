/**
 * Fixtures for seat-pricing: one good artifact (also the reference solution), the
 * broken variants the specification names, and a static fake.
 *
 * Every broken variant is the good artifact with one or more MARKED REGIONS
 * replaced (see replaceRegion). A region is written as
 *   /*@region:NAME*\/ ... /*@end:NAME*\/        (inside script and style)
 *   <!--@region:NAME--> ... <!--@end:NAME-->    (inside markup)
 * and each replacement is asserted to change the text, so no mutation is a no-op.
 */
import { readFileSync } from 'node:fs'
import { HIDDEN_VERSION } from './hidden'

export const FIXTURES_VERSION = HIDDEN_VERSION

// ---------------------------------------------------------------------------
// The good artifact
// ---------------------------------------------------------------------------
export const goodArtifact = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relay Pricing</title>
<style>
/*@region:tokens*/
:root{
  --bg:#0c0c10;
  --surface:#15151d;
  --surface-2:#1c1c26;
  --line:#2a2a38;
  --text:#ececf3;
  --muted:#a9a9ba;
  --accent:#2563eb;
  --accent-hover:#1d4ed8;
  --on-accent:#ffffff;
  --ring:#93c5fd;
  --danger:#fca5a5;
  --ok:#86efac;
  --highlight:#fde68a;
  --net:#3b82f6;
  --tax:#f59e0b;
  --saved:#22c55e;
  color-scheme:dark;
}
/*@end:tokens*/
html,body{margin:0;padding:0;min-height:100%;box-sizing:border-box;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
*,*::before,*::after{box-sizing:border-box}
body{line-height:1.5;-webkit-font-smoothing:antialiased}
/*@region:focus-css*/
:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
/*@end:focus-css*/
main{max-width:1120px;margin:0 auto;padding:24px 16px 64px}
[hidden]{display:none !important}
h1{font-size:clamp(28px,4.2vw,44px);line-height:1.1;margin:0 0 12px;letter-spacing:-0.02em}
h2{font-size:20px;line-height:1.3;margin:0 0 12px;letter-spacing:-0.01em}
h3{font-size:18px;line-height:1.3;margin:0}
button{font:inherit}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:8px 0 24px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;letter-spacing:-0.01em}
.mark{display:inline-block;width:28px;height:28px;border-radius:9px;background:var(--accent)}
.topbar p{margin:0;color:var(--muted);font-size:14px}
.hero{padding:16px 0 32px;max-width:720px}
.eyebrow{margin:0 0 8px;color:var(--ring);font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase}
.lede{margin:0;color:var(--muted);font-size:17px;max-width:60ch}
.btn{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;border:1px solid var(--line);border-radius:12px;background:var(--surface-2);color:var(--text);font-weight:600;cursor:pointer}
.btn:hover:not(:disabled){border-color:#3a3a4c}
.btn:disabled{opacity:0.45;cursor:not-allowed}
.btn-primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent);width:100%;min-height:52px;font-size:16px}
.btn-primary:hover:not(:disabled){background:var(--accent-hover);border-color:var(--accent-hover)}
/*@region:plans-css*/
.plan-grid{display:grid;gap:16px;grid-template-columns:1fr}
@media (min-width:960px){.plan-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
/*@end:plans-css*/
.plan{display:flex;flex-direction:column;gap:14px;min-width:0;padding:22px;background:var(--surface);border:1px solid var(--line);border-radius:16px}
.plan.is-selected{border-color:var(--net);box-shadow:0 0 0 1px var(--net)}
.plan-head{display:flex;flex-direction:column;gap:4px}
.blurb{margin:0;color:var(--muted);font-size:14px}
.badge{align-self:flex-start;margin:0;padding:2px 10px;border-radius:999px;background:var(--highlight);color:#0c0c10;font-size:12px;font-weight:700}
.price{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin:0}
.price-amount{font-size:34px;font-weight:700;letter-spacing:-0.02em}
.price-unit{color:var(--muted);font-size:14px}
.features{display:grid;gap:6px;margin:0;padding:0 0 0 18px;font-size:15px}
.features li::marker{color:var(--ok)}
.choose{width:100%}
.choose[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.workspace{display:grid;gap:24px;margin-top:32px}
@media (min-width:960px){.workspace{grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);align-items:start}}
.panel{min-width:0;padding:24px;background:var(--surface);border:1px solid var(--line);border-radius:18px}
.field{display:grid;gap:8px;margin:0 0 22px}
.field-label{font-weight:600;font-size:15px}
.hint{margin:0;color:var(--muted);font-size:14px}
.msg{margin:0;min-height:1.5em;font-size:14px}
#seats-error{color:var(--danger)}
#promo-status[data-state="applied"]{color:var(--ok)}
#promo-status[data-state="error"]{color:var(--danger)}
#promo-status[data-state="none"]{color:var(--muted)}
#checkout-note{color:var(--ok)}
.segmented{display:flex;flex-wrap:wrap;gap:10px}
.seg{display:inline-flex;align-items:center;gap:10px;min-height:44px;padding:8px 16px;border:1px solid var(--line);border-radius:999px;background:var(--surface-2);cursor:pointer}
.seg:has(input:checked){border-color:var(--accent);background:#1e2a4a}
/*@region:radio-css*/
.seg input[type="radio"]{appearance:none;-webkit-appearance:none;flex:none;width:18px;height:18px;margin:0;border:2px solid #7a7a8e;border-radius:50%;background:transparent}
.seg input[type="radio"]:checked{border-color:var(--ring);background:var(--ring);box-shadow:inset 0 0 0 3px #1e2a4a}
/*@end:radio-css*/
.stepper{display:grid;grid-template-columns:48px minmax(0,1fr) 48px;gap:8px}
.step{padding:0;font-size:20px;line-height:1}
input[type="text"],select{width:100%;min-height:48px;padding:10px 14px;border:1px solid var(--line);border-radius:12px;background:var(--surface-2);color:var(--text);font:inherit;font-size:16px}
input[type="text"]::placeholder{color:var(--muted);opacity:1}
#seats{text-align:center;font-variant-numeric:tabular-nums}
#seats[aria-invalid="true"]{border-color:var(--danger)}
.promo-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}
.summary-meta{margin:0 0 16px;color:var(--muted);font-size:14px}
.lines{display:grid;margin:0 0 16px}
.line{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:10px 0;border-bottom:1px solid var(--line)}
.amount{font-variant-numeric:tabular-nums;font-weight:600;text-align:right}
.line.total{padding-top:16px;border-bottom:none}
.line.total .amount{font-size:26px;letter-spacing:-0.01em}
.line.per-seat .label{color:var(--muted)}
.bar-wrap{margin:8px 0 20px}
.bar{display:flex;height:12px;overflow:hidden;border-radius:999px;background:var(--surface-2)}
/*@region:bar-css*/
.bar > span{flex-basis:0;flex-shrink:0;flex-grow:0;min-width:0}
/*@end:bar-css*/
.bar > [data-segment="net"]{background:var(--net)}
.bar > [data-segment="tax"]{background:var(--tax)}
.bar > [data-segment="saved"]{background:var(--saved)}
.legend{display:flex;flex-wrap:wrap;gap:16px;margin:12px 0 0;padding:0;list-style:none;color:var(--muted);font-size:13px}
.legend li{display:inline-flex;align-items:center;gap:8px}
.sw{display:inline-block;width:10px;height:10px;border-radius:3px}
.sw.net{background:var(--net)}
.sw.tax{background:var(--tax)}
.sw.saved{background:var(--saved)}
.fine{margin:20px 0 0;color:var(--muted);font-size:13px}
.boot-error{margin:0 0 16px;padding:12px 14px;border-radius:12px;background:#3b1212;color:var(--danger)}
/*@region:extra-css*/
/*@end:extra-css*/
</style>
</head>
<!--@region:body-tag--><body><!--@end:body-tag-->
<main>
  <header class="topbar">
    <div class="brand"><span class="mark" aria-hidden="true"></span>Relay</div>
    <p>Team chat for product, design and support</p>
  </header>

  <section class="hero">
    <p class="eyebrow">Pricing</p>
    <h1>Team chat that prices the way your team grows</h1>
    <p class="lede">Choose a plan, set your seat count and watch the order summary update as you type. Volume pricing applies to every seat automatically, and annual billing takes 17% off the subtotal.</p>
  </section>

  <section aria-labelledby="plans-title">
    <h2 id="plans-title">Plans</h2>
    <div class="plan-grid">
<!--@region:plan-cards-->
      <article class="plan" data-plan-card="starter">
        <div class="plan-head">
          <h3>Starter</h3>
          <p class="blurb">For small crews setting up their first workspace.</p>
        </div>
        <p class="price"><span class="price-amount">$9.00</span><span class="price-unit">per seat / month</span></p>
        <ul class="features">
          <li>Unlimited public channels</li>
          <li>30 days of message history</li>
          <li>Email support</li>
        </ul>
        <!--@region:btn-starter-->
        <button type="button" class="btn choose" data-plan="starter" aria-pressed="false">Choose Starter</button>
        <!--@end:btn-starter-->
      </article>

      <article class="plan is-selected" data-plan-card="team">
        <div class="plan-head">
          <p class="badge">Most popular</p>
          <h3>Team</h3>
          <p class="blurb">For product and support teams that work in the open.</p>
        </div>
        <p class="price"><span class="price-amount">$14.50</span><span class="price-unit">per seat / month</span></p>
        <ul class="features">
          <li>Everything in Starter</li>
          <li>Unlimited message history</li>
          <li>Shared workspace admin</li>
        </ul>
        <!--@region:btn-team-->
        <button type="button" class="btn choose" data-plan="team" aria-pressed="true">Choose Team</button>
        <!--@end:btn-team-->
      </article>

      <article class="plan" data-plan-card="scale">
        <div class="plan-head">
          <h3>Scale</h3>
          <p class="blurb">For organisations that run many teams on one system.</p>
        </div>
        <p class="price"><span class="price-amount">$23.75</span><span class="price-unit">per seat / month</span></p>
        <ul class="features">
          <li>Everything in Team</li>
          <li>SAML single sign-on</li>
          <li>Audit log export</li>
        </ul>
        <!--@region:btn-scale-->
        <button type="button" class="btn choose" data-plan="scale" aria-pressed="false">Choose Scale</button>
        <!--@end:btn-scale-->
      </article>
<!--@end:plan-cards-->
    </div>
  </section>

  <div class="workspace">
    <section class="panel" aria-labelledby="config-title">
      <h2 id="config-title">Configure your order</h2>

      <div class="field">
        <span class="field-label" id="billing-label">Billing period</span>
        <div class="segmented" role="radiogroup" aria-labelledby="billing-label">
          <label class="seg" for="billing-monthly"><input type="radio" name="billing" id="billing-monthly" value="monthly" checked><span>Monthly</span></label>
          <label class="seg" for="billing-annual"><input type="radio" name="billing" id="billing-annual" value="annual"><span>Annual</span></label>
        </div>
      </div>

      <div class="field">
        <label class="field-label" for="seats">Seats</label>
        <div class="stepper">
          <!--@region:btn-dec-->
          <button type="button" id="seats-dec" class="btn step" aria-label="Decrease seats">&minus;</button>
          <!--@end:btn-dec-->
          <input id="seats" type="text" inputmode="numeric" autocomplete="off" value="5" aria-describedby="seats-hint seats-error">
          <!--@region:btn-inc-->
          <button type="button" id="seats-inc" class="btn step" aria-label="Increase seats">+</button>
          <!--@end:btn-inc-->
        </div>
        <p class="hint" id="seats-hint">Whole number from 1 to 5,000. Spaces around the number are fine.</p>
        <p class="msg" id="seats-error"></p>
      </div>

      <div class="field">
        <label class="field-label" for="promo">Promo code</label>
        <div class="promo-row">
          <input id="promo" type="text" autocomplete="off" spellcheck="false" placeholder="Try LAUNCH20">
          <button type="button" id="promo-apply" class="btn" aria-label="Apply promo code">Apply</button>
        </div>
        <p class="msg" id="promo-status" data-state="none">Enter a code, then press Apply.</p>
      </div>

      <div class="field">
        <label class="field-label" for="region">Tax region</label>
        <select id="region">
          <option value="none">No tax</option>
          <option value="ca">California (7.25%)</option>
          <option value="ny">New York (8.875%)</option>
          <option value="uk">United Kingdom (20% VAT)</option>
          <option value="de">Germany (19% VAT)</option>
        </select>
      </div>
    </section>

    <aside class="panel" id="summary" aria-labelledby="summary-title">
      <h2 id="summary-title">Order summary</h2>
      <p class="summary-meta" id="summary-meta">Team, 5 seats, monthly</p>
      <div class="lines">
        <div class="line"><span class="label">Subtotal</span><span class="amount" id="subtotal" data-cents="7250">$72.50</span></div>
        <div class="line"><span class="label">Annual discount (17%)</span><span class="amount" id="annual-discount" data-cents="0">$0.00</span></div>
        <div class="line"><span class="label">Promo discount</span><span class="amount" id="promo-discount" data-cents="0">$0.00</span></div>
        <div class="line"><span class="label">Tax</span><span class="amount" id="tax" data-cents="0">$0.00</span></div>
        <div class="line total" aria-live="polite"><span class="label">Total</span><span class="amount" id="total" data-cents="7250">$72.50</span></div>
        <div class="line per-seat"><span class="label">Per seat, per month</span><span class="amount" id="per-seat" data-cents="1450">$14.50</span></div>
      </div>
      <div class="bar-wrap">
        <div class="bar" id="breakdown" aria-hidden="true">
          <span data-segment="net"></span>
          <span data-segment="tax"></span>
          <span data-segment="saved"></span>
        </div>
        <ul class="legend">
          <li><i class="sw net"></i>Net after discounts</li>
          <li><i class="sw tax"></i>Tax</li>
          <li><i class="sw saved"></i>Saved</li>
        </ul>
      </div>
      <button type="button" id="checkout" class="btn btn-primary">Checkout</button>
      <p class="msg" id="checkout-note" role="status"></p>
      <p class="fine">Prices are in US dollars. Annual billing is charged once a year for every seat.</p>
    </aside>
  </div>

<!--@region:extra-markup--><!--@end:extra-markup-->
  <div id="boot-error" class="boot-error" role="alert" hidden></div>
</main>
<!--@region:script-->
<script>
(function () {
  'use strict';

  var SEATS_MIN = 1;
  var SEATS_MAX = 5000;
  var SEATS_MESSAGE = 'Enter a whole number of seats from 1 to 5,000.';
  var LIST = { starter: 900n, team: 1450n, scale: 2375n };
  var PLAN_LABEL = { starter: 'Starter', team: 'Team', scale: 'Scale' };
  var RATE = { none: 0n, ca: 7250n, ny: 8875n, uk: 20000n, de: 19000n };
  var FLAT50 = 5000n;
  var AMOUNT_IDS = ['subtotal', 'annual-discount', 'promo-discount', 'tax', 'total', 'per-seat'];

  var state = { plan: 'team', code: '' };

  function el(id) { return document.getElementById(id); }

  // Round half up for non-negative integers: exact halves go up, applied once.
  function rhu(num, den) { return (2n * num + den) / (2n * den); }

  function normaliseCode(raw) { return String(raw).trim().toUpperCase(); }

  // Seats text: trimmed, ASCII digits only, 1 to 5000. Null when invalid.
  function parseSeats(text) {
    /*@region:parse*/
    var t = String(text).trim();
    if (!/^[0-9]+$/.test(t)) return null;
    var n = Number(t);
    return n >= SEATS_MIN && n <= SEATS_MAX ? n : null;
    /*@end:parse*/
  }

  // Graduated weight in percent points summed over seats: 100 = full list price.
  function tierWeight(n) {
    /*@region:tiers*/
    var t1 = n < 10n ? n : 10n;
    var t2 = n > 10n ? (n < 50n ? n - 10n : 40n) : 0n;
    var t3 = n > 50n ? (n < 200n ? n - 50n : 150n) : 0n;
    var t4 = n > 200n ? n - 200n : 0n;
    return t1 * 100n + t2 * 90n + t3 * 80n + t4 * 70n;
    /*@end:tiers*/
  }

  // Every amount in whole cents. One rounding per stated step, in the stated order.
  function priceCore(seats, annual, code, plan, region) {
    var n = BigInt(seats);
    var months = annual ? 12n : 1n;
    /*@region:arith*/
    var subtotal = rhu(months * LIST[plan] * tierWeight(n), 100n);
    var annualDiscount = annual ? rhu(subtotal * 17n, 100n) : 0n;
    var base = subtotal - annualDiscount;
    var promoDiscount = 0n;
    var promoState = 'none';
    if (code === 'LAUNCH20') {
      promoDiscount = rhu(base * 20n, 100n);
      promoState = 'applied';
    } else if (code === 'FLAT50') {
      promoDiscount = base < FLAT50 ? base : FLAT50;
      promoState = 'applied';
    } else if (code === 'TEAM10' && plan !== 'starter' && seats >= 5) {
      promoDiscount = rhu(base * 10n, 100n);
      promoState = 'applied';
    } else if (code !== '') {
      promoState = 'error';
    }
    var taxable = base - promoDiscount;
    var tax = rhu(taxable * RATE[region], 100000n);
    var total = taxable + tax;
    var perSeat = rhu(total, n * months);
    return {
      subtotal: subtotal, annualDiscount: annualDiscount, promoDiscount: promoDiscount,
      taxable: taxable, tax: tax, total: total, perSeat: perSeat, promoState: promoState
    };
    /*@end:arith*/
  }

  function money(cents, discount) {
    /*@region:money*/
    var negative = discount && cents > 0n;
    var whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    var frac = (cents % 100n).toString().padStart(2, '0');
    return (negative ? '−' : '') + '$' + whole + '.' + frac;
    /*@end:money*/
  }

  function promoMessage(promoState, code, plan) {
    if (promoState === 'none') return 'Enter a code, then press Apply.';
    if (promoState === 'applied') {
      if (code === 'LAUNCH20') return 'LAUNCH20 applied: 20% off after the annual discount.';
      if (code === 'FLAT50') return 'FLAT50 applied: $50 off, or the whole amount if it is smaller.';
      return 'TEAM10 applied: 10% off Team and Scale orders of 5 seats or more.';
    }
    if (code === 'TEAM10') return 'TEAM10 needs the Team or Scale plan and at least 5 seats.';
    return '"' + code + '" is not a valid promo code.';
  }

  function showDashes() {
    AMOUNT_IDS.forEach(function (id) {
      var node = el(id);
      node.textContent = '—';
      node.setAttribute('data-cents', '');
    });
  }

  function setBar(net, tax, saved) {
    var bar = el('breakdown');
    /*@region:bar-js*/
    bar.querySelector('[data-segment="net"]').style.flexGrow = String(Number(net));
    bar.querySelector('[data-segment="tax"]').style.flexGrow = String(Number(tax));
    bar.querySelector('[data-segment="saved"]').style.flexGrow = String(Number(saved));
    /*@end:bar-js*/
  }

  function syncPlans() {
    document.querySelectorAll('[data-plan]').forEach(function (button) {
      var on = button.getAttribute('data-plan') === state.plan;
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    document.querySelectorAll('[data-plan-card]').forEach(function (card) {
      card.classList.toggle('is-selected', card.getAttribute('data-plan-card') === state.plan);
    });
    /*@region:sync-extra*/
    /*@end:sync-extra*/
  }

  function render() {
    var seatsInput = el('seats');
    var seats = parseSeats(seatsInput.value);
    var valid = seats !== null;
    seatsInput.setAttribute('aria-invalid', valid ? 'false' : 'true');
    el('seats-error').textContent = valid ? '' : SEATS_MESSAGE;
    el('seats-dec').disabled = !valid || seats <= SEATS_MIN;
    el('seats-inc').disabled = !valid || seats >= SEATS_MAX;
    el('checkout').disabled = !valid;
    syncPlans();
    if (!valid) {
      showDashes();
      setBar(0n, 0n, 0n);
      el('summary-meta').textContent = 'Fix the seat count to see your totals.';
      return;
    }
    var annual = el('billing-annual').checked;
    var r = priceCore(seats, annual, state.code, state.plan, el('region').value);
    el('subtotal').textContent = money(r.subtotal, false);
    el('subtotal').setAttribute('data-cents', String(r.subtotal));
    el('annual-discount').textContent = money(r.annualDiscount, true);
    el('annual-discount').setAttribute('data-cents', String(r.annualDiscount));
    el('promo-discount').textContent = money(r.promoDiscount, true);
    el('promo-discount').setAttribute('data-cents', String(r.promoDiscount));
    el('tax').textContent = money(r.tax, false);
    el('tax').setAttribute('data-cents', String(r.tax));
    el('total').textContent = money(r.total, false);
    el('total').setAttribute('data-cents', String(r.total));
    el('per-seat').textContent = money(r.perSeat, false);
    el('per-seat').setAttribute('data-cents', String(r.perSeat));
    setBar(r.taxable, r.tax, r.annualDiscount + r.promoDiscount);
    var status = el('promo-status');
    status.setAttribute('data-state', r.promoState);
    status.textContent = promoMessage(r.promoState, state.code, state.plan);
    el('summary-meta').textContent = PLAN_LABEL[state.plan] + ', ' + seats + (seats === 1 ? ' seat' : ' seats') + ', ' + (annual ? 'annual' : 'monthly');
  }

  function applyPromo() {
    /*@region:apply*/
    state.code = normaliseCode(el('promo').value);
    /*@end:apply*/
    render();
  }

  function stepSeats(delta) {
    var seats = parseSeats(el('seats').value);
    if (seats === null) return;
    var next = Math.min(SEATS_MAX, Math.max(SEATS_MIN, seats + delta));
    el('seats').value = String(next);
    render();
  }

  function init() {
    document.querySelectorAll('[data-plan]').forEach(function (button) {
      button.addEventListener('click', function () {
        state.plan = button.getAttribute('data-plan');
        render();
      });
    });
    el('billing-monthly').addEventListener('change', render);
    el('billing-annual').addEventListener('change', render);
    el('seats').addEventListener('input', render);
    el('seats').addEventListener('change', render);
    el('seats-dec').addEventListener('click', function () { stepSeats(-1); });
    el('seats-inc').addEventListener('click', function () { stepSeats(1); });
    el('promo-apply').addEventListener('click', applyPromo);
    /*@region:promo-input*/
    /*@end:promo-input*/
    el('promo').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyPromo();
      }
    });
    el('region').addEventListener('change', render);
    el('checkout').addEventListener('click', function () {
      if (el('checkout').disabled) return;
      el('checkout-note').textContent = 'Preview only: nothing is charged in this demo.';
    });
    render();
  }

  try {
    init();
  } catch (error) {
    var box = el('boot-error');
    box.textContent = 'The calculator could not start: ' + (error && error.message ? error.message : String(error));
    box.hidden = false;
  }
})();
</script>
<!--@end:script-->
</body>
</html>
`

// ---------------------------------------------------------------------------
// Region replacement
// ---------------------------------------------------------------------------

/** Replace the text between the markers of one region. Asserts the change is real. */
export function replaceRegion(source: string, name: string, replacement: string | ((old: string) => string)): string {
  const startTok = `@region:${name}`
  const endTok = `@end:${name}`
  const si = source.indexOf(startTok)
  const ei = source.indexOf(endTok)
  if (si < 0 || ei < 0) throw new Error(`region ${name} is not in the good artifact`)
  if (source.indexOf(startTok, si + 1) >= 0 || source.indexOf(endTok, ei + 1) >= 0) {
    throw new Error(`region ${name} is not unique`)
  }
  const startHtml = source.slice(si - 4, si) === '<!--'
  const closeStart = startHtml ? '-->' : '*/'
  const contentStart = source.indexOf(closeStart, si) + closeStart.length
  const endHtml = source.slice(ei - 4, ei) === '<!--'
  const contentEnd = endHtml ? ei - 4 : ei - 2
  if (contentEnd < contentStart) throw new Error(`region ${name} is malformed`)
  const old = source.slice(contentStart, contentEnd)
  const next = typeof replacement === 'function' ? replacement(old) : replacement
  if (next === old) throw new Error(`mutation of region ${name} did not change the text`)
  return source.slice(0, contentStart) + next + source.slice(contentEnd)
}

/** Apply several region replacements in order, asserting the whole artifact changed. */
export function mutate(source: string, replacements: ReadonlyArray<[string, string | ((old: string) => string)]>): string {
  let out = source
  for (const [region, replacement] of replacements) out = replaceRegion(out, region, replacement)
  if (out === source) throw new Error('mutation left the artifact unchanged')
  return out
}

// ---------------------------------------------------------------------------
// Replacement bodies
// ---------------------------------------------------------------------------

/** Every seat priced at the bracket N falls in (no graduated pricing). */
const TIERS_ALL_SEATS_AT_BRACKET = String.raw`return n <= 10n ? n * 100n : n <= 50n ? n * 90n : n <= 200n ? n * 80n : n * 70n;`

/** Promo on the subtotal before the annual discount; TEAM10 read from a flag set at apply time. */
const ARITH_PROMO_BEFORE_ANNUAL = String.raw`var subtotal = rhu(months * LIST[plan] * tierWeight(n), 100n);
    var promoDiscount = 0n;
    var promoState = 'none';
    if (code === 'LAUNCH20') {
      promoDiscount = rhu(subtotal * 20n, 100n);
      promoState = 'applied';
    } else if (code === 'FLAT50') {
      promoDiscount = subtotal < FLAT50 ? subtotal : FLAT50;
      promoState = 'applied';
    } else if (code === 'TEAM10' && state.team10Ok) {
      promoDiscount = rhu(subtotal * 10n, 100n);
      promoState = 'applied';
    } else if (code !== '') {
      promoState = 'error';
    }
    var annualDiscount = annual ? rhu((subtotal - promoDiscount) * 17n, 100n) : 0n;
    var taxable = subtotal - promoDiscount - annualDiscount;
    var tax = rhu(taxable * RATE[region], 100000n);
    var total = taxable + tax;
    var perSeat = rhu(total, n * months);
    return {
      subtotal: subtotal, annualDiscount: annualDiscount, promoDiscount: promoDiscount,
      taxable: taxable, tax: tax, total: total, perSeat: perSeat, promoState: promoState
    };`

/** TEAM10 validity captured when the code is applied, not re-checked when seats change. */
const APPLY_TEAM10_AT_APPLY_TIME = String.raw`state.code = normaliseCode(el('promo').value);
    state.team10Ok = state.plan !== 'starter' && (parseSeats(el('seats').value) || 0) >= 5;`

/** Integer cents with float multipliers (Math.round(x * 0.0725) style). */
const ARITH_INT_CENTS_FLOAT_MULTIPLIERS = String.raw`var N = seats;
    var m = annual ? 12 : 1;
    var listCents = { starter: 900, team: 1450, scale: 2375 }[plan];
    var rateFloat = { none: 0, ca: 0.0725, ny: 0.08875, uk: 0.2, de: 0.19 }[region];
    var t1 = Math.min(N, 10);
    var t2 = Math.max(0, Math.min(N, 50) - 10);
    var t3 = Math.max(0, Math.min(N, 200) - 50);
    var t4 = Math.max(0, N - 200);
    var sub = Math.round(m * listCents * (t1 + t2 * 0.9 + t3 * 0.8 + t4 * 0.7));
    var ad = annual ? Math.round(sub * 0.17) : 0;
    var base = sub - ad;
    var pd = 0;
    var st = 'none';
    if (code === 'LAUNCH20') { pd = Math.round(base * 0.2); st = 'applied'; }
    else if (code === 'FLAT50') { pd = Math.min(5000, base); st = 'applied'; }
    else if (code === 'TEAM10' && plan !== 'starter' && N >= 5) { pd = Math.round(base * 0.1); st = 'applied'; }
    else if (code !== '') { st = 'error'; }
    var taxable = base - pd;
    var tax = Math.round(taxable * rateFloat);
    var total = taxable + tax;
    var per = Math.round(total / (N * m));
    return {
      subtotal: BigInt(sub), annualDiscount: BigInt(ad), promoDiscount: BigInt(pd),
      taxable: BigInt(taxable), tax: BigInt(tax), total: BigInt(total), perSeat: BigInt(per), promoState: st
    };`

/** All money as float dollars, rounded with Math.round(x * 100) / 100 at each step. */
const ARITH_FLOAT_DOLLARS = String.raw`var N = seats;
    var m = annual ? 12 : 1;
    var planDollars = { starter: 9.0, team: 14.5, scale: 23.75 }[plan];
    var rateFloat = { none: 0, ca: 0.0725, ny: 0.08875, uk: 0.2, de: 0.19 }[region];
    var r2 = function (x) { return Math.round(x * 100) / 100; };
    var sum = 0;
    for (var i = 1; i <= N; i++) sum += planDollars * (i <= 10 ? 1 : i <= 50 ? 0.9 : i <= 200 ? 0.8 : 0.7);
    var subD = r2(sum * m);
    var adD = annual ? r2(subD * 0.17) : 0;
    var baseD = subD - adD;
    var pdD = 0;
    var st = 'none';
    if (code === 'LAUNCH20') { pdD = r2(baseD * 0.2); st = 'applied'; }
    else if (code === 'FLAT50') { pdD = Math.min(50, baseD); st = 'applied'; }
    else if (code === 'TEAM10' && plan !== 'starter' && N >= 5) { pdD = r2(baseD * 0.1); st = 'applied'; }
    else if (code !== '') { st = 'error'; }
    var taxableD = baseD - pdD;
    var taxD = r2(taxableD * rateFloat);
    var totD = taxableD + taxD;
    var perD = r2(totD / (N * m));
    var cents = function (x) { return BigInt(Math.round(x * 100)); };
    return {
      subtotal: cents(subD), annualDiscount: cents(adD), promoDiscount: cents(pdD),
      taxable: cents(taxableD), tax: cents(taxD), total: cents(totD), perSeat: cents(perD), promoState: st
    };`

/** parseInt and Number both accepted: '12abc', '1e3', '+5', '12.5', '0x10'. */
const PARSE_PARSEINT = String.raw`var t = String(text).trim();
    var n = Number(t) || parseInt(t, 10);
    return n >= SEATS_MIN && n <= SEATS_MAX ? Math.floor(n) : null;`

/** Plain $ and toFixed(2): no thousands separators. */
const MONEY_TOFIXED = String.raw`return (discount && cents > 0n ? '−' : '') + '$' + (Number(cents) / 100).toFixed(2);`

/** A global rule removes the focus ring with no replacement. */
const FOCUS_NONE = String.raw`*:focus,*:focus-visible{outline:none !important}`

/** Three fixed 340px columns and no breakpoint. */
const PLANS_FIXED = String.raw`.plan-grid{display:grid;gap:16px;grid-template-columns:repeat(3,340px)}`

/** Segments carry a 48px minimum, so zero amounts still draw. */
const BAR_MIN_WIDTH = String.raw`.bar > span{flex-basis:0;flex-shrink:0;flex-grow:0;min-width:48px}`

/** Grey labels and a 3.68:1 blue button. */
function greyAndBlue(old: string): string {
  const once = (text: string, from: string, to: string): string => {
    if (text.split(from).length !== 2) throw new Error(`token ${from} must occur once`)
    return text.replace(from, to)
  }
  return once(once(old, '--muted:#a9a9ba;', '--muted:#6b7280;'), '--accent:#2563eb;', '--accent:#3b82f6;')
}

/** Region body for one button: the same indentation the good markup uses. */
function buttonRegion(markup: string): string {
  return '\n        ' + markup + '\n        '
}

/** Icon-only steppers: no aria-label, so the accessible names are the glyphs. */
const STEPPER_DEC = String.raw`<button type="button" id="seats-dec" class="btn step">&minus;</button>`
const STEPPER_INC = String.raw`<button type="button" id="seats-inc" class="btn step">+</button>`

/** Every plan button named Select, the pressed state kept as in the good artifact. */
function planButtonSelect(plan: 'starter' | 'team' | 'scale', pressed: boolean): string {
  const aria = pressed ? 'true' : 'false'
  return buttonRegion(`<button type="button" class="btn choose" data-plan="${plan}" aria-pressed="${aria}">Select</button>`)
}

// ---------------------------------------------------------------------------
// The broken variants and the static fake
// ---------------------------------------------------------------------------

/** Append CSS to the end of the style block. */
function extraCss(css: string): (old: string) => string {
  return (old) => old + css + '\n'
}

/** A conforming ordinary CSS transition on the bar segments. */
const BAR_TRANSITION = String.raw`.bar > span{flex-basis:0;flex-shrink:0;flex-grow:0;min-width:0;transition:flex-grow .3s ease}`

/** Error reveal with a max-height transition (the message is hidden until seats are invalid). */
const ERROR_REVEAL = String.raw`#seats-error{min-height:0;max-height:0;overflow:hidden;transition:max-height .25s ease}
.field:has(#seats[aria-invalid="true"]) #seats-error{max-height:3em}`

/** A focus indicator drawn by a border colour change, eased in, with the outline removed. */
const BORDER_FOCUS_EASE = String.raw`:focus-visible{outline:none !important;border-color:#ffffff !important}
.btn,input,select{transition:border-color .3s ease-in}`

/** A focus indicator drawn by a background colour change, eased in, with the outline removed. */
const BACKGROUND_FOCUS_EASE = String.raw`:focus-visible{outline:none !important;background-color:#2a3a66 !important}
.btn,input,select{transition:background-color .25s ease-in-out}`

/** Visually hidden radios (opacity 0, the given box) with the focus ring drawn on the label. */
function radioHidden(box: string): string {
  return String.raw`.seg{position:relative}
.seg input[type="radio"]{position:absolute;opacity:0;${box};margin:0;outline:none}
.seg:has(input:focus-visible){outline:2px solid var(--ring);outline-offset:2px}`
}

/** An entrance animation: content is opacity 0 at rest and animates to 1 with fill-mode forwards. */
const ENTRANCE = String.raw`@keyframes rise{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}
.topbar,.hero,.plan,.panel,section > h2{opacity:0;animation:rise .5s ease forwards}`

/**
 * Translucent surfaces: the plan and panel cards are 4.5% white over the dark page, and the
 * text fields and the select are 6% white. A conforming page; the focus ring is judged on the
 * composite (the dark card), not on white.
 */
const TRANSLUCENT_SURFACES = String.raw`.plan,.panel{background:rgba(255,255,255,0.045)}
input[type="text"],select{background-color:rgba(255,255,255,0.06)}`

/** A 12 x 8 chevron as a data url with an explicit intrinsic size, in the given stroke colour. */
function chevronImage(stroke: string): string {
  return `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='${stroke}' stroke-width='2'/%3E%3C/svg%3E")`
}

/**
 * A translucent select (6% white) with a chevron image, over the solid panel on the dark page: the
 * composite under the chevron is opaque, so the chevron is an icon and not a backdrop.
 */
const TRANSLUCENT_SELECT = String.raw`select{background-color:rgba(255,255,255,0.06);padding-right:40px;background-image:${chevronImage('%23ececf3')};background-repeat:no-repeat;background-position:right 14px center}`

/** The classic two-gradient CSS chevron: two explicit 5 px gradients on an opaque select. */
const TWO_GRADIENT_CHEVRON = String.raw`select{appearance:none;-webkit-appearance:none;padding-right:40px;background-color:#1c1c26;background-image:linear-gradient(45deg,transparent 50%,#ececf3 50%),linear-gradient(135deg,#ececf3 50%,transparent 50%);background-position:calc(100% - 20px) 50%,calc(100% - 15px) 50%;background-size:5px 5px,5px 5px;background-repeat:no-repeat}`

/** A Tailwind-forms chevron: 1.5em on a 48 px select, placed at right 0.5rem, centred. */
const TAILWIND_CHEVRON_48 = String.raw`select{appearance:none;-webkit-appearance:none;padding-right:40px;background-color:#1c1c26;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3E%3Cpath stroke='%23ececf3' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3E%3C/svg%3E");background-position:right 0.5rem center;background-repeat:no-repeat;background-size:1.5em 1.5em}`

/** A 40 px select with a 12 x 8 chevron at the right. */
const CHEVRON_40 = String.raw`select{appearance:none;-webkit-appearance:none;height:40px;min-height:0;padding:6px 40px 6px 12px;background-color:#1c1c26;background-image:${chevronImage('%23ececf3')};background-repeat:no-repeat;background-position:right 12px center;background-size:12px 8px}`

/** The chevron at background-size auto 8px: the width follows from the image's own 12 x 8 shape. */
const CHEVRON_AUTO_HEIGHT = String.raw`select{appearance:none;-webkit-appearance:none;padding-right:40px;background-color:#1c1c26;background-image:${chevronImage('%23ececf3')};background-repeat:no-repeat;background-position:right 14px center;background-size:auto 8px}`

/** No html or body background: the page canvas is the used Canvas colour that color-scheme: dark paints. */
const CANVAS_FROM_COLOUR_SCHEME = String.raw`html,body{background:none}`

/**
 * A fixed z-index -1 page colour beneath translucent cards, with the root backgrounds transparent.
 * The canvas is then the used Canvas colour, which stands in for the painted layer behind the cards.
 */
const FIXED_BACKDROP_BODY = `<body><div aria-hidden="true" style="position:fixed;inset:0;z-index:-1;background:#0c0c10"></div>`
const FIXED_BACKDROP_CSS = `html,body{background:none}\n${TRANSLUCENT_SURFACES}`

/** A dark ring (#2a2a38) on the translucent cards: about 1.3:1 against the dark card, 14:1 against white. */
const DARK_RING_FOCUS = String.raw`:focus-visible{outline:2px solid #2a2a38;outline-offset:2px}`

/** A full-box white image under the select's text: no-repeat, sized 100% 100%, so it is a backdrop, not an icon. */
const FULL_BOX_IMAGE_UNDER_SELECT = String.raw`select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='2' height='2'%3E%3Crect width='2' height='2' fill='%23ffffff'/%3E%3C/svg%3E");background-size:100% 100%;background-repeat:no-repeat}`

/** Zero-amount segments hidden with the hidden attribute. */
const BAR_ZERO_HIDDEN = String.raw`    [['net', net], ['tax', tax], ['saved', saved]].forEach(function (pair) {
      var seg = bar.querySelector('[data-segment="' + pair[0] + '"]');
      seg.style.flexGrow = String(Number(pair[1]));
      seg.hidden = Number(pair[1]) === 0;
    });`

/** The promo code is tracked from the input event and applied on Apply or Enter. */
const APPLY_FROM_DRAFT = String.raw`state.code = normaliseCode(state.draft || '');`
const PROMO_INPUT_LISTENER = String.raw`el('promo').addEventListener('input', function (event) { state.draft = event.target.value; });`

/** Each plan card also carries data-plan (the card is not the selection button). */
function cardsWithDataPlan(markup: string): string {
  return markup.replace(/data-plan-card="(starter|team|scale)">/g, 'data-plan-card="$1" data-plan="$1">')
}

/** The body reflects the selected plan (set on every render). */
const BODY_TEAM = String.raw`<body data-plan="team">`
const BODY_PLAN_SYNC = String.raw`
    document.body.setAttribute('data-plan', state.plan);
    `

/** Every plan button shares one accessible name that contains all three plan names. */
function planButtonSharedName(plan: 'starter' | 'team' | 'scale', pressed: boolean): string {
  const aria = pressed ? 'true' : 'false'
  const shown = plan === 'starter' ? 'Starter' : plan === 'team' ? 'Team' : 'Scale'
  return buttonRegion(
    `<button type="button" class="btn choose" data-plan="${plan}" aria-pressed="${aria}" aria-label="Choose Starter, Team or Scale">Choose ${shown}</button>`
  )
}

// ---------------------------------------------------------------------------
// Contrast fixtures: markup and CSS for the paint-based audit (contrast.ts). Each goes into the
// extra-markup region (after the workspace) and, where it needs styling, the extra-css region.
// ---------------------------------------------------------------------------

/** Two lines. The backdrop is dark behind line 1 and pale behind line 2, so line 2 cannot be read. */
const FADE_MARKUP = String.raw`<section class="contrast-demo"><p class="demo-fade">Seat changes apply to the next invoice and never reach a closed one.</p></section>`
const FADE_CSS = String.raw`.demo-fade{max-width:34ch;margin:0;padding:0;line-height:24px;color:var(--text);background:linear-gradient(#15151d 0 50%,#e4e4ec 50% 100%)}`

/** Three lines. Line 1 sits on dark, lines 2 and 3 on stripes that are pale half their width (not readable there). */
const BUSY_UNREADABLE_MARKUP = String.raw`<section class="contrast-demo"><p class="demo-busy">Seat changes apply to the next invoice, prorated to the day, and never reach an invoice that has closed. Annual plans bill once a year.</p></section>`
const BUSY_UNREADABLE_CSS = String.raw`.demo-busy{max-width:34ch;margin:0;padding:0;line-height:24px;color:var(--text);background:linear-gradient(#0c0c10 0 24px,transparent 24px),repeating-linear-gradient(90deg,#0c0c10 0 4px,#f2f2f6 4px 8px)}`

/** The same two lines over dark stripes only: readable everywhere. */
const BUSY_READABLE_MARKUP = String.raw`<section class="contrast-demo"><p class="demo-busy-ok">Seat changes apply to the next invoice and never reach a closed one.</p></section>`
const BUSY_READABLE_CSS = String.raw`.demo-busy-ok{max-width:34ch;margin:0;padding:0;line-height:24px;color:var(--text);background:repeating-linear-gradient(90deg,#0c0c10 0 4px,#1c1c26 4px 8px)}`

/** Three lines on a gradient, readable from the first line to the last. */
const MULTILINE_READABLE_MARKUP = String.raw`<section class="contrast-demo"><p class="demo-multi">Seat changes apply to the next invoice, prorated to the day, and never reach an invoice that has closed. Annual plans bill once a year and renew on the same date.</p></section>`
const MULTILINE_READABLE_CSS = String.raw`.demo-multi{max-width:44ch;margin:0;padding:8px 12px;line-height:24px;color:var(--text);background:linear-gradient(#15151d,#24242f)}`

/** Three panels collapsed by height, clip-path and max-height with overflow hidden. Their text is not painted. */
const COLLAPSED_ACCORDION_MARKUP = String.raw`<section class="contrast-demo" aria-labelledby="acc-title"><h2 id="acc-title">Billing terms</h2><div class="acc-panel" style="height:0;overflow:hidden"><p>Seat changes take effect on the next invoice and are prorated to the day.</p></div><div class="acc-panel" style="clip-path:inset(100%)"><p>Annual plans renew once a year. Cancel before renewal to stop the charge.</p></div><div class="acc-panel" style="max-height:0;overflow:hidden"><p>Refunds go to the original payment method within ten working days.</p></div></section>`

/** A middle dot in its own span, between words. Its glyph is a few pixels, so it has nothing to measure. */
const SEPARATOR_MARKUP = String.raw`<section class="contrast-demo"><p class="demo-sep"><span>Team</span><span class="sep"> · </span><span>5 seats</span><span class="sep"> · </span><span>Monthly</span></p></section>`
const SEPARATOR_CSS = String.raw`.demo-sep{margin:0;color:var(--text);font-size:15px}.demo-sep .sep{color:var(--muted)}`

/** A dark, soft text-shadow on a headline over an image-like layer. The text itself is readable. */
const DARK_SHADOW_MARKUP = String.raw`<section class="contrast-demo shadow-card"><h2 class="demo-shadow">Readable headline over a dark texture</h2><p class="demo-shadow-body">Body copy on the same texture stays readable.</p></section>`
const DARK_SHADOW_CSS = String.raw`.shadow-card{padding:24px;border-radius:18px;background:repeating-linear-gradient(135deg,#0c0c10 0 12px,#1c1c26 12px 24px)}.demo-shadow{margin:0 0 8px;color:#ffffff;font-size:26px;line-height:1.2;text-shadow:0 3px 10px #000,0 0 2px #000}.demo-shadow-body{margin:0;color:var(--text)}`

/** Dark text with a hard white shadow. The shadow is the strongest ink, but the text is low-contrast. */
const HARD_SHADOW_MARKUP = String.raw`<section class="contrast-demo"><p class="demo-hard">Low contrast headline with a hard white shadow</p></section>`
const HARD_SHADOW_CSS = String.raw`.demo-hard{margin:0;display:inline-block;padding:8px 14px;background:#0c0c10;color:#34343f;font-size:20px;font-weight:700;text-shadow:3px 3px 0 #ffffff}`

/** A fixed bottom bar with readable text. The page below it scrolls under the bar. */
const BOTTOM_BAR_MARKUP = String.raw`<div class="bottom-bar"><p>Questions about invoices? Email billing support for a reply within one working day.</p></div>`
const BOTTOM_BAR_CSS = String.raw`.bottom-bar{position:fixed;left:0;right:0;bottom:0;z-index:5;padding:14px 16px;background:#15151d;border-top:1px solid var(--line)}.bottom-bar p{margin:0 auto;max-width:1120px;color:var(--muted);font-size:14px}`

/** Low-contrast text in the page, with a transparent fixed bar on top of it. The bar hides nothing: the text must fail. */
const LOW_UNDER_BAR_MARKUP = String.raw`<section class="contrast-demo"><p class="demo-low-under-bar">Overage is billed at the end of each month, on the seats used that month.</p></section><div class="bottom-bar bar-clear"><p>Overage terms apply to every plan.</p></div>`
const LOW_UNDER_BAR_CSS = String.raw`.demo-low-under-bar{margin:0;max-width:60ch;padding:8px 0;color:#2a2a38;background:#0c0c10;font-size:15px}.bottom-bar.bar-clear{background:transparent;border-top:0}`

/**
 * Reveal-on-scroll text: opacity 0 until an IntersectionObserver adds a class. The audit must scroll to it
 * (revealAll) before it reads the page, or low-contrast text could hide behind the reveal.
 */
const REVEAL_SCRIPT = String.raw`<script>
(function () {
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) { entry.target.classList.add('is-in'); io.unobserve(entry.target); }
    });
  });
  document.querySelectorAll('.reveal-text').forEach(function (el) { io.observe(el); });
})();
</script>`
/** Outline text drawn only by its shadows (the fill is transparent). The shadow is the glyph, and it reads 17:1. */
const OUTLINE_MARKUP = String.raw`<section class="contrast-demo"><p class="demo-outline">Outlined headline drawn by its shadows</p></section>`
const OUTLINE_CSS = String.raw`.demo-outline{margin:0;font-size:24px;font-weight:700;color:var(--text);-webkit-text-fill-color:transparent;text-shadow:1px 0 0 currentColor,-1px 0 0 currentColor,0 1px 0 currentColor,0 -1px 0 currentColor}`

/** Thin text at 4.65:1 over two lines, where the second line has few fully covered pixels. Must pass. */
const NEAR_THRESHOLD_MARKUP = String.raw`<section class="contrast-demo"><p class="demo-near">Annual billing saves seventeen percent on every seat, and the saving is shown on each invoice before you confirm the order and pay.</p></section>`
const NEAR_THRESHOLD_CSS = String.raw`.demo-near{max-width:34ch;margin:0;padding:0;font-size:13px;font-weight:300;line-height:1.5;color:#80808c;background:#15151d}`

const REVEAL_CSS = String.raw`.reveal-text{opacity:0;transition:opacity .5s ease;margin:0;padding:8px 0;max-width:60ch;font-size:16px}.reveal-text.is-in{opacity:1}.reveal-spacer{height:1400px}`
const REVEAL_READABLE_MARKUP = String.raw`<section class="contrast-demo"><div class="reveal-spacer" aria-hidden="true"></div><p class="reveal-text" style="color:var(--text)">Seat changes apply to the next invoice and never reach a closed one.</p></section>` + REVEAL_SCRIPT
const REVEAL_LOW_MARKUP = String.raw`<section class="contrast-demo"><div class="reveal-spacer" aria-hidden="true"></div><p class="reveal-text" style="color:#2a2a38;background:#0c0c10">Seat changes apply to the next invoice and never reach a closed one.</p></section>` + REVEAL_SCRIPT

export const FIXTURE_NAMES = {
  good: 'pricing-good',
  volume: 'pricing-broken-volume-pricing',
  promoBeforeAnnual: 'pricing-broken-promo-before-annual',
  floatMultipliers: 'pricing-broken-float-multipliers',
  plainToFixed: 'pricing-broken-plain-tofixed',
  parseIntSeats: 'pricing-broken-parseint-seats',
  outlineNone: 'pricing-broken-outline-none',
  iconSteppers: 'pricing-broken-icon-steppers',
  mutedGrey: 'pricing-broken-muted-grey',
  fixedGrid: 'pricing-broken-fixed-grid',
  barMinWidth: 'pricing-broken-bar-min-width',
  controlFloatDollars: 'pricing-control-float-dollars',
  staticFake: 'pricing-control-static-fake',
  // Conforming variants: each must score 100.
  goodSmoothScroll: 'pricing-good-smooth-scroll',
  goodBarTransition: 'pricing-good-bar-transition',
  goodErrorReveal: 'pricing-good-error-reveal',
  goodBorderFocusEase: 'pricing-good-border-focus-ease-in',
  goodBackgroundFocusEase: 'pricing-good-background-focus-ease',
  goodLabelFocusRing: 'pricing-good-label-focus-ring',
  goodZeroSizeRadio: 'pricing-good-zero-size-radio',
  goodZeroSegmentHidden: 'pricing-good-zero-segment-hidden',
  goodPromoFromInput: 'pricing-good-promo-from-input',
  goodCardDataPlan: 'pricing-good-card-data-plan',
  goodBodyDataPlan: 'pricing-good-body-data-plan',
  goodEntranceAnimation: 'pricing-good-entrance-animation',
  goodTranslucentCards: 'pricing-good-translucent-cards',
  goodTranslucentSelect: 'pricing-good-translucent-select-chevron',
  goodTwoGradientChevron: 'pricing-good-two-gradient-chevron',
  goodTailwindChevron48: 'pricing-good-tailwind-chevron-48px',
  goodChevron40: 'pricing-good-chevron-40px',
  goodChevronAutoHeight: 'pricing-good-chevron-auto-height',
  goodCanvasColourScheme: 'pricing-good-canvas-colour-scheme',
  goodFixedBackdrop: 'pricing-good-fixed-backdrop-translucent',
  goodBusyTextureReadable: 'pricing-good-busy-texture-readable',
  goodMultilineReadable: 'pricing-good-multiline-readable',
  goodCollapsedAccordion: 'pricing-good-collapsed-accordion',
  goodSeparatorSpans: 'pricing-good-separator-spans',
  goodDarkShadowReadable: 'pricing-good-dark-shadow-readable',
  goodFixedBottomBar: 'pricing-good-fixed-bottom-bar',
  cheatLowContrastUnderBar: 'pricing-cheat-low-contrast-under-bar',
  goodRevealOnScroll: 'pricing-good-reveal-on-scroll',
  goodOutlineShadowOnly: 'pricing-good-outline-shadow-only',
  goodNearThresholdTwoLines: 'pricing-good-near-threshold-two-lines',
  cheatRevealLowContrast: 'pricing-cheat-reveal-on-scroll-low-contrast',
  brokenFadeIntoBackdrop: 'pricing-broken-fade-into-backdrop',
  brokenBusyTexture: 'pricing-broken-busy-texture',
  cheatHardShadowLowContrast: 'pricing-cheat-hard-shadow-low-contrast-text',
  // Cheats: each must fail the named check(s).
  cheatStaticConstants: 'pricing-cheat-static-constants',
  cheatConstantsNoSeparators: 'pricing-cheat-constants-no-separators',
  cheatInvisiblePage: 'pricing-cheat-invisible-page',
  cheatMutedGreyEntrance: 'pricing-cheat-muted-grey-entrance',
  cheatIdenticalPlanNames: 'pricing-cheat-identical-plan-names',
  cheatTransparentOutline: 'pricing-cheat-transparent-outline',
  cheatTranslucentDarkRing: 'pricing-cheat-translucent-dark-ring',
  cheatChevronFullBoxImage: 'pricing-cheat-chevron-full-box-image',
} as const

/** Conforming variants of the good artifact (each expected to score 100). */
export const goodVariantDefinitions: ReadonlyArray<{
  name: string
  replacements: ReadonlyArray<[string, string | ((old: string) => string)]>
}> = [
  { name: FIXTURE_NAMES.goodSmoothScroll, replacements: [['extra-css', extraCss('html{scroll-behavior:smooth}')]] },
  { name: FIXTURE_NAMES.goodBarTransition, replacements: [['bar-css', BAR_TRANSITION]] },
  { name: FIXTURE_NAMES.goodErrorReveal, replacements: [['extra-css', extraCss(ERROR_REVEAL)]] },
  {
    name: FIXTURE_NAMES.goodBorderFocusEase,
    replacements: [
      ['focus-css', ':focus-visible{outline-offset:2px}'],
      ['extra-css', extraCss(BORDER_FOCUS_EASE)],
    ],
  },
  {
    name: FIXTURE_NAMES.goodBackgroundFocusEase,
    replacements: [
      ['focus-css', ':focus-visible{outline-offset:2px}'],
      ['extra-css', extraCss(BACKGROUND_FOCUS_EASE)],
    ],
  },
  { name: FIXTURE_NAMES.goodLabelFocusRing, replacements: [['radio-css', radioHidden('width:1px;height:1px')]] },
  { name: FIXTURE_NAMES.goodZeroSizeRadio, replacements: [['radio-css', radioHidden('width:0;height:0')]] },
  { name: FIXTURE_NAMES.goodZeroSegmentHidden, replacements: [['bar-js', BAR_ZERO_HIDDEN]] },
  {
    name: FIXTURE_NAMES.goodPromoFromInput,
    replacements: [
      ['apply', APPLY_FROM_DRAFT],
      ['promo-input', PROMO_INPUT_LISTENER],
    ],
  },
  { name: FIXTURE_NAMES.goodCardDataPlan, replacements: [['plan-cards', cardsWithDataPlan]] },
  {
    name: FIXTURE_NAMES.goodBodyDataPlan,
    replacements: [
      ['body-tag', BODY_TEAM],
      ['sync-extra', BODY_PLAN_SYNC],
    ],
  },
  { name: FIXTURE_NAMES.goodEntranceAnimation, replacements: [['extra-css', extraCss(ENTRANCE)]] },
  { name: FIXTURE_NAMES.goodTranslucentCards, replacements: [['extra-css', extraCss(TRANSLUCENT_SURFACES)]] },
  { name: FIXTURE_NAMES.goodTranslucentSelect, replacements: [['extra-css', extraCss(TRANSLUCENT_SELECT)]] },
  { name: FIXTURE_NAMES.goodTwoGradientChevron, replacements: [['extra-css', extraCss(TWO_GRADIENT_CHEVRON)]] },
  { name: FIXTURE_NAMES.goodTailwindChevron48, replacements: [['extra-css', extraCss(TAILWIND_CHEVRON_48)]] },
  { name: FIXTURE_NAMES.goodChevron40, replacements: [['extra-css', extraCss(CHEVRON_40)]] },
  { name: FIXTURE_NAMES.goodChevronAutoHeight, replacements: [['extra-css', extraCss(CHEVRON_AUTO_HEIGHT)]] },
  { name: FIXTURE_NAMES.goodCanvasColourScheme, replacements: [['extra-css', extraCss(CANVAS_FROM_COLOUR_SCHEME)]] },
  {
    name: FIXTURE_NAMES.goodFixedBackdrop,
    replacements: [
      ['body-tag', FIXED_BACKDROP_BODY],
      ['extra-css', extraCss(FIXED_BACKDROP_CSS)],
    ],
  },
  {
    name: FIXTURE_NAMES.goodBusyTextureReadable,
    replacements: [
      ['extra-markup', BUSY_READABLE_MARKUP],
      ['extra-css', extraCss(BUSY_READABLE_CSS)],
    ],
  },
  {
    name: FIXTURE_NAMES.goodMultilineReadable,
    replacements: [
      ['extra-markup', MULTILINE_READABLE_MARKUP],
      ['extra-css', extraCss(MULTILINE_READABLE_CSS)],
    ],
  },
  { name: FIXTURE_NAMES.goodCollapsedAccordion, replacements: [['extra-markup', COLLAPSED_ACCORDION_MARKUP]] },
  {
    name: FIXTURE_NAMES.goodSeparatorSpans,
    replacements: [
      ['extra-markup', SEPARATOR_MARKUP],
      ['extra-css', extraCss(SEPARATOR_CSS)],
    ],
  },
  {
    name: FIXTURE_NAMES.goodDarkShadowReadable,
    replacements: [
      ['extra-markup', DARK_SHADOW_MARKUP],
      ['extra-css', extraCss(DARK_SHADOW_CSS)],
    ],
  },
  {
    name: FIXTURE_NAMES.goodFixedBottomBar,
    replacements: [
      ['extra-markup', BOTTOM_BAR_MARKUP],
      ['extra-css', extraCss(BOTTOM_BAR_CSS)],
    ],
  },
  {
    name: FIXTURE_NAMES.goodRevealOnScroll,
    replacements: [
      ['extra-markup', REVEAL_READABLE_MARKUP],
      ['extra-css', extraCss(REVEAL_CSS)],
    ],
  },
  {
    name: FIXTURE_NAMES.goodOutlineShadowOnly,
    replacements: [
      ['extra-markup', OUTLINE_MARKUP],
      ['extra-css', extraCss(OUTLINE_CSS)],
    ],
  },
  {
    name: FIXTURE_NAMES.goodNearThresholdTwoLines,
    replacements: [
      ['extra-markup', NEAR_THRESHOLD_MARKUP],
      ['extra-css', extraCss(NEAR_THRESHOLD_CSS)],
    ],
  },
]

export const FIXTURE_GOOD_NAMES: readonly string[] = [FIXTURE_NAMES.good, ...goodVariantDefinitions.map((d) => d.name)]

export const brokenDefinitions: ReadonlyArray<{
  name: string
  replacements: ReadonlyArray<[string, string | ((old: string) => string)]>
}> = [
  { name: FIXTURE_NAMES.volume, replacements: [['tiers', TIERS_ALL_SEATS_AT_BRACKET]] },
  {
    name: FIXTURE_NAMES.promoBeforeAnnual,
    replacements: [
      ['arith', ARITH_PROMO_BEFORE_ANNUAL],
      ['apply', APPLY_TEAM10_AT_APPLY_TIME],
    ],
  },
  { name: FIXTURE_NAMES.floatMultipliers, replacements: [['arith', ARITH_INT_CENTS_FLOAT_MULTIPLIERS]] },
  { name: FIXTURE_NAMES.plainToFixed, replacements: [['money', MONEY_TOFIXED]] },
  { name: FIXTURE_NAMES.parseIntSeats, replacements: [['parse', PARSE_PARSEINT]] },
  { name: FIXTURE_NAMES.outlineNone, replacements: [['focus-css', FOCUS_NONE]] },
  {
    name: FIXTURE_NAMES.iconSteppers,
    replacements: [
      ['btn-dec', buttonRegion(STEPPER_DEC)],
      ['btn-inc', buttonRegion(STEPPER_INC)],
      ['btn-starter', planButtonSelect('starter', false)],
      ['btn-team', planButtonSelect('team', true)],
      ['btn-scale', planButtonSelect('scale', false)],
    ],
  },
  { name: FIXTURE_NAMES.mutedGrey, replacements: [['tokens', greyAndBlue]] },
  { name: FIXTURE_NAMES.fixedGrid, replacements: [['plans-css', PLANS_FIXED]] },
  { name: FIXTURE_NAMES.barMinWidth, replacements: [['bar-css', BAR_MIN_WIDTH]] },
  { name: FIXTURE_NAMES.controlFloatDollars, replacements: [['arith', ARITH_FLOAT_DOLLARS]] },
  // Cheats: a page that passed a check it should not pass, with the check now strengthened.
  {
    name: FIXTURE_NAMES.cheatStaticConstants,
    replacements: [
      ['script', ''],
      ['bar-css', extraCss('.bar > [data-segment="net"]{flex-grow:1}')],
    ],
  },
  {
    // The default amounts written as '$' + toFixed(2) with no separators, and never changed.
    name: FIXTURE_NAMES.cheatConstantsNoSeparators,
    replacements: [
      [
        'script',
        String.raw`<script>
(function () {
  var shown = {
    subtotal: ['7250', '$72.50'], 'annual-discount': ['0', '$0.00'], 'promo-discount': ['0', '$0.00'],
    tax: ['0', '$0.00'], total: ['7250', '$72.50'], 'per-seat': ['1450', '$14.50']
  };
  Object.keys(shown).forEach(function (id) {
    var node = document.getElementById(id);
    node.setAttribute('data-cents', shown[id][0]);
    node.textContent = shown[id][1];
  });
})();
</script>`,
      ],
      ['bar-css', extraCss('.bar > [data-segment="net"]{flex-grow:1}')],
    ],
  },
  { name: FIXTURE_NAMES.cheatInvisiblePage, replacements: [['extra-css', extraCss('main{opacity:0}')]] },
  {
    name: FIXTURE_NAMES.cheatMutedGreyEntrance,
    replacements: [
      ['tokens', greyAndBlue],
      ['extra-css', extraCss(ENTRANCE)],
    ],
  },
  {
    name: FIXTURE_NAMES.cheatIdenticalPlanNames,
    replacements: [
      ['btn-starter', planButtonSharedName('starter', false)],
      ['btn-team', planButtonSharedName('team', true)],
      ['btn-scale', planButtonSharedName('scale', false)],
    ],
  },
  {
    // White headline text over a white photo that fills the box, on a black background-colour: the
    // text is invisible on the image, but the colour alone reads 21:1. Must fail the contrast audit.
    name: 'pricing-cheat-cover-photo-under-text',
    replacements: [
      [
        'extra-css',
        extraCss(
          `h1{color:#ffffff !important;background:#000 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='2' height='2'%3E%3Crect width='2' height='2' fill='%23ffffff'/%3E%3C/svg%3E") no-repeat center/cover}`
        ),
      ],
    ],
  },
  {
    name: FIXTURE_NAMES.cheatTransparentOutline,
    replacements: [['focus-css', ':focus-visible{outline:1px solid transparent;outline-offset:2px}']],
  },
  {
    // The translucent cards with a dark ring. Judged on white (the old, wrong backdrop) the ring passes at 14:1;
    // judged on the dark card it is 1.3:1. Must fail the keyboard check and nothing else.
    name: FIXTURE_NAMES.cheatTranslucentDarkRing,
    replacements: [
      ['extra-css', extraCss(TRANSLUCENT_SURFACES)],
      ['focus-css', DARK_RING_FOCUS],
    ],
  },
  {
    // A select whose text sits over a full-box white image. It is opaque, so the old icon rule let the
    // image through as an icon. Must fail the contrast check and nothing else.
    name: FIXTURE_NAMES.cheatChevronFullBoxImage,
    replacements: [['extra-css', extraCss(FULL_BOX_IMAGE_UNDER_SELECT)]],
  },
  {
    // Line 2 sits on a pale backdrop: the text is nearly the colour of what it sits on. Must fail the contrast audit.
    name: FIXTURE_NAMES.brokenFadeIntoBackdrop,
    replacements: [
      ['extra-markup', FADE_MARKUP],
      ['extra-css', extraCss(FADE_CSS)],
    ],
  },
  {
    // Light text over stripes that are pale for half their width. Unreadable on the pale stripes. Must fail the contrast audit.
    name: FIXTURE_NAMES.brokenBusyTexture,
    replacements: [
      ['extra-markup', BUSY_UNREADABLE_MARKUP],
      ['extra-css', extraCss(BUSY_UNREADABLE_CSS)],
    ],
  },
  {
    // Dark text with a hard white shadow. The shadow is the strongest ink; the text itself is about 1.6:1. Must fail.
    name: FIXTURE_NAMES.cheatHardShadowLowContrast,
    replacements: [
      ['extra-markup', HARD_SHADOW_MARKUP],
      ['extra-css', extraCss(HARD_SHADOW_CSS)],
    ],
  },
  {
    // Text about 1.3:1 with a transparent fixed bar over it. The bar hides nothing, so a result under it stands. Must fail.
    name: FIXTURE_NAMES.cheatLowContrastUnderBar,
    replacements: [
      ['extra-markup', LOW_UNDER_BAR_MARKUP],
      ['extra-css', extraCss(LOW_UNDER_BAR_CSS)],
    ],
  },
  {
    // Text about 1.3:1 that only appears when scrolled to. The audit must reveal it, so it must fail.
    name: FIXTURE_NAMES.cheatRevealLowContrast,
    replacements: [
      ['extra-markup', REVEAL_LOW_MARKUP],
      ['extra-css', extraCss(REVEAL_CSS)],
    ],
  },
]

/**
 * Static fake: the script region is emptied (no handlers, no bar widths) and the
 * plan grid is the fixed three-column layout. Names and palette stay sound, so the
 * names and contrast checks can pass; everything that needs behaviour fails.
 */
export const staticFakeArtifact = mutate(goodArtifact, [
  ['script', ''],
  ['plans-css', PLANS_FIXED],
])

export const brokenArtifacts: Readonly<Record<string, string>> = Object.fromEntries(
  brokenDefinitions.map((d) => [d.name, mutate(goodArtifact, d.replacements)])
)

/** Every fixture the matrix runs, in report order. */
export const goodVariantArtifacts: Readonly<Record<string, string>> = Object.fromEntries(
  goodVariantDefinitions.map((d) => [d.name, mutate(goodArtifact, d.replacements)])
)

/** A page kept under variants/: a conforming page or a fault written by the reviewer. */
function variantPage(file: string): string {
  return readFileSync(new URL(`./variants/${file}.html`, import.meta.url), 'utf8')
}

/**
 * Whole pages written by the reviewer. Conforming ones must score 100; the faults each
 * have an expectation below.
 */
const PAGE_VARIANTS: ReadonlyArray<{ name: string; html: string }> = [
  // A select with a no-repeat chevron on an opaque colour: the chevron is an icon, not a backdrop.
  { name: 'pricing-good-select-chevron', html: variantPage('good-select-chevron') },
  // The seats field with ARIA spinbutton semantics (a stepper).
  { name: 'pricing-good-seats-spinbutton', html: variantPage('good-seats-spinbutton') },
  // A headline whose glyphs are a gradient (background-clip: text), read from its colour stops.
  { name: 'pricing-good-gradient-headline', html: variantPage('good-gradient-headline') },
  // Round-two conforming pages: a promo with a left icon indented by text-indent, and a select whose last line is centred
  // with a left icon (text-align-last).
  { name: 'pricing-good-promo-text-indent-left-icon', html: variantPage('G2-promo-left-icon-text-indent') },
  { name: 'pricing-good-select-text-align-last-left-icon', html: variantPage('G4-select-centred-last-left-icon') },
  // Faults: a focus ring the colour of the page; text painted in a grey fill; the page dimmed by a filter; no lang.
  { name: 'pricing-broken-focus-ring-background-colour', html: variantPage('broken-focus-ring-background-colour') },
  { name: 'pricing-cheat-text-fill-grey', html: variantPage('broken-text-fill-grey') },
  { name: 'pricing-cheat-filter-dim', html: variantPage('broken-filter-dim') },
  { name: 'pricing-broken-no-lang', html: variantPage('broken-no-lang') },
  // Round-two cheats: text hidden under an image, by a background origin, text-indent, or an SVG blob URL.
  { name: 'pricing-cheat-origin-content-box-over-text', html: variantPage('K1-origin-content-box-over-text') },
  { name: 'pricing-cheat-text-indent-over-image', html: variantPage('K1c-text-indent-over-image') },
  { name: 'pricing-cheat-blob-svg-under-text', html: variantPage('K2d-text-colour-blob-url-auto') },
  // Round four (adversarial review). Text parked outside the viewport is not painted: skipped, not failed.
  { name: 'pricing-good-skip-link-top-offscreen', html: variantPage('r4-SK1-P-skip-link-top-minus-40') },
  { name: 'pricing-good-skip-link-translate-offscreen', html: variantPage('r4-SK2-P-skip-link-translateY') },
  { name: 'pricing-good-skip-link-left-offscreen', html: variantPage('r4-SK3-P-skip-link-left-9999') },
  { name: 'pricing-good-toast-parked-offscreen', html: variantPage('r4-SK4-P-toast-parked-offscreen') },
  { name: 'pricing-good-offcanvas-drawer', html: variantPage('r4-SK5-P-offcanvas-drawer') },
  { name: 'pricing-good-visually-hidden-helper', html: variantPage('r4-FF08-P-visually-hidden-left-9999') },
  // Text over a backdrop that is not a CSS image layer (plain boxes, an image, an SVG, a canvas), or with a cover: must fail.
  { name: 'pricing-broken-split-band-divs-h1', html: variantPage('r4-FP01-F-h1-split-band-solid-divs') },
  { name: 'pricing-broken-split-band-lede', html: variantPage('r4-FP02-F-lede-split-band-solid') },
  { name: 'pricing-broken-gradient-clip-fade', html: variantPage('r4-FP03-F-gradient-clip-text-fades-out') },
  { name: 'pricing-broken-mask-fade-blurb', html: variantPage('r4-FP04-F-mask-fade-blurb') },
  { name: 'pricing-broken-white-text-noise-canvas', html: variantPage('r4-FP06-F-white-text-over-noise-canvas') },
  { name: 'pricing-broken-quartile-band-20pct', html: variantPage('r4-FP09-F-quartile-band-20pct-of-each-line') },
  { name: 'pricing-broken-half-covered-by-block', html: variantPage('r4-FP14-F-half-covered-by-plain-block') },
  { name: 'pricing-broken-lede-over-svg-blobs', html: variantPage('r4-FP20-F-lede-over-svg-illustration-light-blobs') },
  { name: 'pricing-broken-white-h1-over-photo', html: variantPage('r4-FP21-F-white-h1-over-img-sky-photo') },
  // Readable pages that the reach and time bounds must not fail: a grain overlay on a medium page, a very long page.
  { name: 'pricing-good-medium-page-grain-overlay', html: variantPage('r4-T4-P-medium-page-grain-overlay') },
  { name: 'pricing-good-very-long-page', html: variantPage('r4-FF14-P-very-long-page') },
  // Emoji are colour glyphs, not text colour: a readable emoji on a light surface passes.
  { name: 'pricing-good-emoji-light-theme-badges', html: variantPage('r4-FF33-P-emoji-on-light-theme-badges') },
  { name: 'pricing-good-emoji-own-span-white-pill', html: variantPage('r4-EM4-P-emoji-own-span-white-pill') },
  // Low-contrast text below the fold of a scroll box, or in a carousel slide not yet shown, is measured at its own stop: must fail.
  { name: 'pricing-broken-low-contrast-scroll-box', html: variantPage('r4-FP05b-F-all-low-contrast-below-fold-scroll-box') },
  { name: 'pricing-broken-low-contrast-carousel-slide', html: variantPage('r4-FP17-F-low-contrast-text-in-carousel-offscreen-slide') },
  // A label laid over a filled input is readable: the label owns its pixels.
  { name: 'pricing-good-seats-suffix-overlay', html: variantPage('r4-FF36-P-seats-suffix-overlay') },
  { name: 'pricing-good-promo-input-suffix-overlay', html: variantPage('r4-FF05-P-input-suffix-overlay') },
  // Round five (adversarial review, see the README). Plain text in a light weight reads the colour its CSS sets, not the
  // lighter pixels its hairline strokes leave: each of these is readable and must pass.
  { name: 'pricing-good-helvetica-light-body', html: variantPage('r5-H1-P-helvetica-neue-300-body-good-palette') },
  { name: 'pricing-good-slate-helvetica-light-secondary', html: variantPage('r5-H2-P-slate-dark-helvetica-neue-300-secondary') },
  { name: 'pricing-good-system-light-secondary', html: variantPage('r5-H3-P-slate-dark-system-300-secondary') },
  { name: 'pricing-good-font-grid-light-weights', html: variantPage('r5-H7-font-grid-slate400-on-slate800') },
  { name: 'pricing-good-avenir-light-lede', html: variantPage('r5-Q20-P-avenir-next-body-400-light-headings-300') },
  { name: 'pricing-good-system-font-weight-300-body', html: variantPage('r5-Q19-P-system-font-weight-300-body') },
  { name: 'pricing-good-hairline-grey-11px', html: variantPage('r5-P04-P-light-theme-767676-11px-weight300') },
  // Gradient text set on a wrapper whose own text is in child spans (the wrapper's gradient is the glyph paint): readable, must pass.
  { name: 'pricing-good-gradient-price-wrapper', html: variantPage('r5-P28-P-gradient-price-wrapper-existing-markup') },
  { name: 'pricing-good-gradient-total-line-wrapper', html: variantPage('r5-P29-P-gradient-total-line-wrapper') },
  { name: 'pricing-good-gradient-words-in-spans', html: variantPage('r5-P01-P-wrapper-gradient-clip-child-spans') },
  // A paragraph whose lower lines lie below the fold, and a headline whose last word sits on a light panel: must fail.
  { name: 'pricing-broken-straddling-fold-lines', html: variantPage('r5-Q03-F-paragraph-straddles-fold-lower-lines-on-light') },
  { name: 'pricing-broken-one-unreadable-word-h1', html: variantPage('r5-Q02a-F-h1-last-word-on-light-art-panel') },
  // Decorative separators (aria-hidden, or outside any control) are not measured, whatever their size; a legacy clip recipe hides text.
  { name: 'pricing-good-dim-pipe-separators-footer', html: variantPage('r5-P31-P-dim-pipe-separators-footer') },
  { name: 'pricing-good-dim-slash-price-unit', html: variantPage('r5-P32-P-price-slash-dim-own-span') },
  { name: 'pricing-good-separators-own-spans', html: variantPage('r5-P25-P-separators-dots-pipes-bullets-own-spans') },
  { name: 'pricing-good-legacy-clip-recipe', html: variantPage('r5-P07-P-legacy-clip-rect-sr-only-no-size') },
  // A marquee whose names sit under a moving mask fade is not measured (skipped and recorded); the page passes.
  { name: 'pricing-good-marquee-mask-fade', html: variantPage('r5-Q12-P-pulsing-badge-and-marquee') },
]

export const fixtures: ReadonlyArray<{ name: string; html: string }> = [
  { name: FIXTURE_NAMES.good, html: goodArtifact },
  ...goodVariantDefinitions.map((d) => ({ name: d.name, html: goodVariantArtifacts[d.name]! })),
  ...brokenDefinitions.map((d) => ({ name: d.name, html: brokenArtifacts[d.name]! })),
  ...PAGE_VARIANTS,
  { name: FIXTURE_NAMES.staticFake, html: staticFakeArtifact },
]

/**
 * The checks each fixture must fail, by name. The good artifact fails none. The
 * static fake passes only the names check and the contrast check.
 */
export const expectations: Readonly<Record<string, readonly string[]>> = {
  [FIXTURE_NAMES.good]: [],
  [FIXTURE_NAMES.volume]: ['pricing-graduated-tiers'],
  // The promo-before-annual defect also changes the total of case 12 (scale, 5 seats, annual, FLAT50, uk), so exact rounding fails too.
  [FIXTURE_NAMES.promoBeforeAnnual]: ['pricing-discount-order', 'pricing-exact-rounding'],
  [FIXTURE_NAMES.floatMultipliers]: ['pricing-exact-rounding'],
  [FIXTURE_NAMES.plainToFixed]: ['pricing-display-format'],
  [FIXTURE_NAMES.parseIntSeats]: ['pricing-seats-validation'],
  [FIXTURE_NAMES.outlineNone]: ['pricing-keyboard'],
  [FIXTURE_NAMES.iconSteppers]: ['pricing-accessible-names'],
  [FIXTURE_NAMES.mutedGrey]: ['pricing-contrast'],
  [FIXTURE_NAMES.fixedGrid]: ['pricing-responsive'],
  [FIXTURE_NAMES.barMinWidth]: ['pricing-breakdown-geometry'],
  [FIXTURE_NAMES.controlFloatDollars]: ['pricing-exact-rounding'],
  [FIXTURE_NAMES.goodSmoothScroll]: [],
  [FIXTURE_NAMES.goodBarTransition]: [],
  [FIXTURE_NAMES.goodErrorReveal]: [],
  [FIXTURE_NAMES.goodBorderFocusEase]: [],
  [FIXTURE_NAMES.goodBackgroundFocusEase]: [],
  [FIXTURE_NAMES.goodLabelFocusRing]: [],
  [FIXTURE_NAMES.goodZeroSizeRadio]: [],
  [FIXTURE_NAMES.goodZeroSegmentHidden]: [],
  [FIXTURE_NAMES.goodPromoFromInput]: [],
  [FIXTURE_NAMES.goodCardDataPlan]: [],
  [FIXTURE_NAMES.goodBodyDataPlan]: [],
  [FIXTURE_NAMES.goodEntranceAnimation]: [],
  // Static constants: no handlers, so the keys do nothing and the amounts never change; the names and the
  // contrast of the static palette and the fluid layout still pass, which is the point of the reach guards.
  [FIXTURE_NAMES.cheatStaticConstants]: [
    'pricing-graduated-tiers',
    'pricing-discount-order',
    'pricing-exact-rounding',
    'pricing-display-format',
    'pricing-seats-validation',
    'pricing-keyboard',
    'pricing-breakdown-geometry',
  ],
  // Working script, main at opacity 0: nothing is visible, so every check that reads what is shown fails.
  // Tiers, exact rounding and the names read the DOM and the labels, which are still correct.
  [FIXTURE_NAMES.cheatConstantsNoSeparators]: [
    'pricing-graduated-tiers',
    'pricing-discount-order',
    'pricing-exact-rounding',
    'pricing-display-format',
    'pricing-seats-validation',
    'pricing-keyboard',
    'pricing-breakdown-geometry',
  ],
  [FIXTURE_NAMES.cheatInvisiblePage]: [
    'pricing-discount-order',
    'pricing-display-format',
    'pricing-seats-validation',
    'pricing-keyboard',
    'pricing-contrast',
    'pricing-responsive',
    'pricing-breakdown-geometry',
  ],
  [FIXTURE_NAMES.cheatMutedGreyEntrance]: ['pricing-contrast'],
  [FIXTURE_NAMES.cheatIdenticalPlanNames]: ['pricing-accessible-names'],
  [FIXTURE_NAMES.cheatTransparentOutline]: ['pricing-keyboard'],
  [FIXTURE_NAMES.goodTranslucentCards]: [],
  [FIXTURE_NAMES.goodTranslucentSelect]: [],
  [FIXTURE_NAMES.goodTwoGradientChevron]: [],
  [FIXTURE_NAMES.goodTailwindChevron48]: [],
  [FIXTURE_NAMES.goodChevron40]: [],
  [FIXTURE_NAMES.goodChevronAutoHeight]: [],
  [FIXTURE_NAMES.goodCanvasColourScheme]: [],
  [FIXTURE_NAMES.goodFixedBackdrop]: [],
  [FIXTURE_NAMES.cheatTranslucentDarkRing]: ['pricing-keyboard'],
  [FIXTURE_NAMES.cheatChevronFullBoxImage]: ['pricing-contrast'],
  'pricing-cheat-cover-photo-under-text': ['pricing-contrast'],
  'pricing-good-select-chevron': [],
  'pricing-good-seats-spinbutton': [],
  'pricing-good-gradient-headline': [],
  'pricing-broken-focus-ring-background-colour': ['pricing-keyboard'],
  'pricing-cheat-text-fill-grey': ['pricing-contrast'],
  'pricing-cheat-filter-dim': ['pricing-contrast'],
  'pricing-broken-no-lang': ['pricing-accessible-names'],
  'pricing-good-promo-text-indent-left-icon': [],
  'pricing-good-select-text-align-last-left-icon': [],
  'pricing-cheat-origin-content-box-over-text': ['pricing-contrast'],
  'pricing-cheat-text-indent-over-image': ['pricing-contrast'],
  'pricing-cheat-blob-svg-under-text': ['pricing-contrast'],
  [FIXTURE_NAMES.goodBusyTextureReadable]: [],
  [FIXTURE_NAMES.goodMultilineReadable]: [],
  [FIXTURE_NAMES.goodCollapsedAccordion]: [],
  [FIXTURE_NAMES.goodSeparatorSpans]: [],
  [FIXTURE_NAMES.goodDarkShadowReadable]: [],
  [FIXTURE_NAMES.goodFixedBottomBar]: [],
  [FIXTURE_NAMES.goodRevealOnScroll]: [],
  [FIXTURE_NAMES.goodOutlineShadowOnly]: [],
  [FIXTURE_NAMES.goodNearThresholdTwoLines]: [],
  [FIXTURE_NAMES.cheatRevealLowContrast]: ['pricing-contrast'],
  [FIXTURE_NAMES.brokenFadeIntoBackdrop]: ['pricing-contrast'],
  [FIXTURE_NAMES.brokenBusyTexture]: ['pricing-contrast'],
  [FIXTURE_NAMES.cheatHardShadowLowContrast]: ['pricing-contrast'],
  [FIXTURE_NAMES.cheatLowContrastUnderBar]: ['pricing-contrast'],
  // Round four (adversarial review), one expectation per fixture added above.
  'pricing-good-skip-link-top-offscreen': [],
  'pricing-good-skip-link-translate-offscreen': [],
  'pricing-good-skip-link-left-offscreen': [],
  'pricing-good-toast-parked-offscreen': [],
  'pricing-good-offcanvas-drawer': [],
  'pricing-good-visually-hidden-helper': [],
  'pricing-broken-split-band-divs-h1': ['pricing-contrast'],
  'pricing-broken-split-band-lede': ['pricing-contrast'],
  'pricing-broken-gradient-clip-fade': ['pricing-contrast'],
  'pricing-broken-mask-fade-blurb': ['pricing-contrast'],
  'pricing-broken-white-text-noise-canvas': ['pricing-contrast'],
  'pricing-broken-quartile-band-20pct': ['pricing-contrast'],
  'pricing-broken-half-covered-by-block': ['pricing-contrast'],
  'pricing-broken-lede-over-svg-blobs': ['pricing-contrast'],
  'pricing-broken-white-h1-over-photo': ['pricing-contrast'],
  'pricing-good-medium-page-grain-overlay': [],
  'pricing-good-very-long-page': [],
  'pricing-good-emoji-light-theme-badges': [],
  'pricing-good-emoji-own-span-white-pill': [],
  'pricing-broken-low-contrast-scroll-box': ['pricing-contrast'],
  'pricing-broken-low-contrast-carousel-slide': ['pricing-contrast'],
  'pricing-good-seats-suffix-overlay': [],
  'pricing-good-promo-input-suffix-overlay': [],
  'pricing-good-helvetica-light-body': [],
  'pricing-good-slate-helvetica-light-secondary': [],
  'pricing-good-system-light-secondary': [],
  'pricing-good-font-grid-light-weights': [],
  'pricing-good-avenir-light-lede': [],
  'pricing-good-system-font-weight-300-body': [],
  'pricing-good-hairline-grey-11px': [],
  'pricing-good-gradient-price-wrapper': [],
  'pricing-good-gradient-total-line-wrapper': [],
  'pricing-good-gradient-words-in-spans': [],
  'pricing-broken-straddling-fold-lines': ['pricing-contrast'],
  'pricing-broken-one-unreadable-word-h1': ['pricing-contrast'],
  'pricing-good-dim-pipe-separators-footer': [],
  'pricing-good-dim-slash-price-unit': [],
  'pricing-good-separators-own-spans': [],
  'pricing-good-legacy-clip-recipe': [],
  'pricing-good-marquee-mask-fade': [],
  [FIXTURE_NAMES.staticFake]: [
    'pricing-graduated-tiers',
    'pricing-discount-order',
    'pricing-exact-rounding',
    'pricing-display-format',
    'pricing-seats-validation',
    'pricing-keyboard',
    'pricing-responsive',
    'pricing-breakdown-geometry',
  ],
}
