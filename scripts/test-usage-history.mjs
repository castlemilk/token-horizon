import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

// Run the actual chart adapters with no DOM, accounts, or network requests.
const source = readFileSync(new URL('../docs/leaderboard.html', import.meta.url), 'utf8');
function extract(name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.notEqual(start, -1, `Missing dashboard function ${name}`);
  const end = source.indexOf('\nfunction ', start + 1);
  assert.notEqual(end, -1, `Missing function boundary after ${name}`);
  return source.slice(start, end);
}
const names = ['aggregateHistory', 'profileProvider', 'profileNumber', 'profileDay', 'profileAnchor', 'profileDaily', 'profileUsageData'];
const colors = source.match(/^const PROFILE_COLORS = .*;$/m)?.[0];
assert(colors, 'Missing profile chart palette');
const helpers = runInNewContext(`${colors}\n${names.map(extract).join('\n')}\n({${names.join(',')}})`, {
  providerKey: value => value,
  providerLabel: value => value,
});
const plain = value => JSON.parse(JSON.stringify(value));
const day = date => Date.parse(date + 'T00:00:00Z') / 1000;
const label = timestamp => new Date(timestamp * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const row = history => ({ entry: { breakdown: { history } } });

test('community history aligns sparse, overlapping profiles by date rather than array position', () => {
  const first = day('2026-01-01'), second = day('2026-01-02'), third = day('2026-01-03');
  const points = plain(helpers.aggregateHistory([
    row([{ day: third, tokens: 30, cost: 3 }, { day: first, tokens: 10, cost: 1 }]),
    row([{ day: second, tokens: 20, cost: 2 }, { day: third, tokens: 7, cost: .7 }]),
  ]));
  assert.deepEqual(points, [
    { day: first, label: label(first), value: 10, cost: 1 },
    { day: second, label: label(second), value: 20, cost: 2 },
    { day: third, label: label(third), value: 37, cost: 3.7 },
  ]);
  assert.equal(points.reduce((sum, point) => sum + point.value, 0), 67);
});

test('community dates normalize epoch seconds, milliseconds, day keys, and offset ISO timestamps to UTC', () => {
  const first = day('2026-01-01');
  const points = plain(helpers.aggregateHistory([
    row([{ day: first + 22 * 3600, tokens: 1, dayLabel: 'Wrong local day' }]),
    row([{ day: first * 1000, tokens: 10 }]),
    row([{ day: first / 86400, tokens: 100 }]),
    row([{ day: '2026-01-02T01:30:00+02:00', tokens: 1000 }]),
  ]));
  assert.deepEqual(points, [{ day: first, label: label(first), value: 1111, cost: 0 }]);
});

test('undated history and cumulative totals cannot become a dated community spike', () => {
  const first = day('2026-01-01');
  const points = plain(helpers.aggregateHistory([
    { entry: { tokensAll: 999999, updatedAt: day('2026-04-01'), breakdown: { history: [
      { dayLabel: 'Today', tokens: 999999 },
      { day: 'invalid', tokens: 999999 },
      { day: 0, tokens: 999999 },
      { day: first, tokens: 12, cost: .5 },
    ] } } },
  ]));
  assert.deepEqual(points, [{ day: first, label: label(first), value: 12, cost: .5 }]);
});

test('empty community history remains empty', () => {
  assert.deepEqual(plain(helpers.aggregateHistory([])), []);
  assert.deepEqual(plain(helpers.aggregateHistory([{ entry: { tokensAll: 9000 } }])), []);
});

test('fresh publication preserves the dates and amounts of historical profile buckets', () => {
  const first = day('2026-01-01'), synced = day('2026-01-10');
  const entry = {
    updatedAt: synced + 12 * 3600,
    tokensAll: 999999,
    breakdown: {
      daily: [{ day: first, tokens: 30 }],
      modelHistory: [{ provider: 'openai', model: 'model', points: [{ day: first, tokens: 30 }] }],
    },
  };
  assert.deepEqual(plain(helpers.profileDaily(entry)), [{ day: first, tokens: 30 }]);
  const chart = plain(helpers.profileUsageData(entry, 14));
  assert.equal(chart.total, 30);
  assert.equal(chart.series[0].values[chart.days.indexOf(first)], 30);
  assert.equal(chart.series[0].values[chart.days.indexOf(synced)], 0, 'Sync day must not receive historical usage');
});

test('history outside the publication window is excluded rather than moved onto sync day', () => {
  const first = day('2026-01-01'), synced = day('2026-04-01');
  const entry = { updatedAt: synced, tokensAll: 999999, breakdown: { daily: [{ day: first, tokens: 30 }] } };
  const chart = plain(helpers.profileUsageData(entry, 7));
  assert.equal(chart.days.at(-1), synced, 'Trailing empty days still end at the publication date');
  assert.equal(chart.total, 0);
  assert.deepEqual(chart.series, []);
  assert.deepEqual(plain(helpers.profileDaily(entry)), [{ day: first, tokens: 30 }]);
});
