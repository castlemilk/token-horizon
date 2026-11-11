/**
 * The public showcase scenario for the gallery capture: Scale, 137 seats, annual,
 * LAUNCH20, New York. Every correct page reads $23,817.65 total and $14.49 per seat.
 *
 * It drives the page only through the prompt's public contract (the plan buttons,
 * the billing radio, #region, #seats, #promo and #promo-apply). No hidden input is
 * used, and no check reads it.
 */
export const pose = String.raw`() => {
  var fire = function (node, type) { node.dispatchEvent(new Event(type, { bubbles: true })); };
  var scale = document.querySelector('[data-plan="scale"]');
  if (scale) scale.click();
  var annual = document.getElementById('billing-annual');
  if (annual) annual.click();
  var region = document.getElementById('region');
  if (region) { region.value = 'ny'; fire(region, 'input'); fire(region, 'change'); }
  var seats = document.getElementById('seats');
  if (seats) { seats.value = '137'; fire(seats, 'input'); fire(seats, 'change'); }
  var promo = document.getElementById('promo');
  var apply = document.getElementById('promo-apply');
  if (promo && apply) { promo.value = 'LAUNCH20'; apply.click(); }
  var total = document.getElementById('total');
  var perSeat = document.getElementById('per-seat');
  return { total: total ? total.textContent : null, perSeat: perSeat ? perSeat.textContent : null };
}`
