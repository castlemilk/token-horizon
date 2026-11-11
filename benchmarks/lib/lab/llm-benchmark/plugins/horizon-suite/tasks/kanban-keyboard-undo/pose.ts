/**
 * Gallery pose for kanban-keyboard-undo: the eight-card board with Doing full and one
 * unbroken 80-character title, reached only through the prompt's public contract (the
 * add form and the move-right buttons). Public inputs only; no check reads them.
 */
export const pose: string = `() => {
  var input = document.getElementById('new-title');
  var add = document.getElementById('add-btn');
  if (!input || !add) return { ok: false, cards: 0 };
  ['Plan the sprint review', 'Review onboarding flow', 'pq'.repeat(40)].forEach(function (t) {
    input.value = t;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    add.click();
  });
  function moveRight(title) {
    var hits = Array.prototype.slice.call(document.querySelectorAll('[data-card]')).filter(function (li) {
      var t = li.querySelector('[data-card-title]');
      return t !== null && t.textContent === title;
    });
    if (hits.length !== 1) return false;
    var btn = hits[0].querySelector('button[data-action="move-right"]');
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  }
  moveRight('Draft release notes');
  moveRight('Fix login redirect');
  return { ok: true, cards: document.querySelectorAll('[data-card]').length };
}`
