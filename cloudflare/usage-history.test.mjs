import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './src/index.js';
import { mergeBreakdownHistory, reconcileBreakdownHistory, exactProviderHistory } from './src/usage-history.js';

const nowSeconds = Date.parse('2026-10-07T12:00:00Z') / 1000;
const day = Math.floor(nowSeconds / 86400) * 86400 - 10 * 3600; // Preserve native local midnight.
const options = { nowSeconds };
const point = (tokens, at = day, cost) => ({ day: at, tokens, ...(cost === undefined ? {} : { cost }) });
const model = (name, tokens, at = day, provider = 'openai', cost) => ({ model: name, provider, points: [point(tokens, at, cost)] });
const sum = (breakdown, at) => breakdown.modelHistory.flatMap(row => row.points).filter(row => row.day === at).reduce((total, row) => total + row.tokens, 0);

test('a changed top-model/Other grouping replaces the whole covered day', () => {
  const previous = { daily: [point(100), point(30, day - 86400)], modelHistory: [model('old-top', 80), model('Other', 20, day, 'other'), model('remote-only', 30, day - 86400)] };
  const incoming = { daily: [point(100)], modelHistory: [model('new-top', 60), model('Other', 40, day, 'other')] };
  const merged = mergeBreakdownHistory(incoming, previous, options);
  assert.equal(sum(merged, day), 100);
  assert.equal(sum(merged, day - 86400), 30);
  assert.equal(merged.modelHistory.some(row => row.model === 'old-top'), false);
  assert.deepEqual(mergeBreakdownHistory(incoming, merged, options), merged, 'Repeating a full snapshot is idempotent');
});

test('new exact values may correct a previously overstated day downward', () => {
  const merged = mergeBreakdownHistory({ daily: [point(7)], modelHistory: [model('fixed', 7)] }, { daily: [point(70)], modelHistory: [model('old', 70)] }, options);
  assert.equal(merged.daily[0].tokens, 7);
  assert.equal(sum(merged, day), 7);
  assert.deepEqual(merged.modelHistory.map(row => row.model), ['fixed']);
});

test('fresh short history outranks a retained daily point for the same date', () => {
  const merged = mergeBreakdownHistory({ history: [point(9)], modelHistory: [model('corrected', 9)] }, { daily: [point(90)], history: [point(90)] }, options);
  assert.equal(merged.daily[0].tokens, 9);
  assert.equal(merged.history[0].tokens, 9);
  assert.equal(sum(merged, day), 9);
});

test('provider and model together identify a series', () => {
  const merged = reconcileBreakdownHistory({ daily: [point(30)], modelHistory: [model('shared-name', 10, day, 'one'), model('shared-name', 20, day, 'two')] }, options);
  assert.deepEqual(merged.modelHistory.map(row => [row.provider, row.points[0].tokens]), [['one', 10], ['two', 20]]);
});

test('an incomplete model split keeps an exact unattributed remainder at its source date', () => {
  const merged = reconcileBreakdownHistory({ daily: [point(10, day, 5)], modelHistory: [model('known', 5, day, 'openai', 2)] }, options);
  const other = merged.modelHistory.find(row => row.model === 'Other');
  assert.deepEqual(other.points, [point(5)]);
  assert.equal(sum(merged, day), 10);
  assert.equal(merged.modelHistory.find(row => row.model === 'known').points[0].cost, 2);
});

test('an impossible legacy overlapping model split falls back to the exact daily total', () => {
  const merged = reconcileBreakdownHistory({ daily: [point(100, day, 3)], modelHistory: [model('top', 80), model('old-top', 30), model('Other', 20, day, 'other')] }, options);
  assert.deepEqual(merged.modelHistory, [{ model: 'Other', provider: 'other', points: [point(100, day, 3)] }]);
});

test('same chart date with inconsistent legacy offsets never doubles an exact day', () => {
  const merged = reconcileBreakdownHistory({ daily: [point(10, day + 3600)], modelHistory: [model('misaligned', 10)] }, options);
  assert.deepEqual(merged.daily, [point(10, day + 3600)]);
  assert.equal(sum(merged, day), 0);
  assert.equal(sum(merged, day + 3600), 10);
  const history = exactProviderHistory([{ breakdown: merged }], 7, options);
  assert.equal(history.points.reduce((value, row) => value + row.total, 0), 10);
});

test('duplicate same-date daily records retain one original source epoch', () => {
  const merged = reconcileBreakdownHistory({ daily: [point(10), point(12, day + 3600)] }, options);
  assert.deepEqual(merged.daily, [point(12, day + 3600)]);
  assert.equal(merged.modelHistory.flatMap(row => row.points).reduce((value, row) => value + row.tokens, 0), 12);
});

test('cross-array offset corrections retain one source epoch without an undefined history row', () => {
  const merged = mergeBreakdownHistory({ daily: [point(12, day + 3600)] }, { history: [point(10)] }, options);
  assert.deepEqual(merged.history, [point(12, day + 3600)]);
  assert.deepEqual(merged.daily, merged.history);
});

test('model-only legacy rows with conflicting offsets cannot double one chart date', () => {
  const merged = reconcileBreakdownHistory({ modelHistory: [model('m', 10), model('m', 12, day + 3600)] }, options);
  assert.deepEqual(merged.modelHistory, [model('m', 12, day + 3600)]);
});

test('absolute hourly snapshots retain epoch-hour keys and merge idempotently', () => {
  const hour = Math.floor(nowSeconds / 3600) * 3600;
  const old = { hourly: [[123]], hourlyHistory: [{ hour: hour - 3600, tokens: 9 }] };
  const next = { hourly: [[456]], hourlyHistory: [{ hour, tokens: 11, cost: 0.5 }] };
  const merged = mergeBreakdownHistory(next, old, options);
  assert.deepEqual(merged.hourlyHistory, [...old.hourlyHistory, ...next.hourlyHistory]);
  assert.deepEqual(merged.hourly, [[456]], 'Weekday grid remains a separate field');
  assert.deepEqual(mergeBreakdownHistory(next, merged, options), merged);
});

test('invalid, stale and future buckets cannot enter exact history', () => {
  const merged = reconcileBreakdownHistory({ daily: [point(-1), point(1, nowSeconds + 86400), point(1, nowSeconds - 140 * 86400), { day, tokens: null }, { day, tokens: 'Infinity' }], hourlyHistory: [{ hour: day + 1, tokens: 1 }, { hour: day, tokens: NaN }] }, options);
  assert.deepEqual(merged.daily, []);
  assert.deepEqual(merged.hourlyHistory, []);
  assert.deepEqual(mergeBreakdownHistory(null, null, options).modelHistory, []);
});

test('cumulative snapshots never assign historical totals or differences to sync dates', () => {
  const end = Math.floor(nowSeconds / 86400);
  const history = exactProviderHistory([
    { updatedAt: nowSeconds, tokensAll: 84_000_000_000, snapshots: [{ day: end - 3, providers: { openai: 31_000_000_000 } }, { day: end, providers: { openai: 84_000_000_000 } }] },
    { updatedAt: nowSeconds, snapshots: [{ day: end, providers: { anthropic: 10_000_000_000 } }] }
  ], 30, options);
  assert.deepEqual(history, { providers: [], points: [] });
});

test('exact provider history uses original dates despite a much later publish time', () => {
  const history = exactProviderHistory([{ updatedAt: nowSeconds, snapshots: [{ day: Math.floor(nowSeconds / 86400), providers: { openai: 999999 } }], breakdown: { daily: [point(17, day - 3 * 86400)], modelHistory: [model('m', 17, day - 3 * 86400)] } }], 7, options);
  assert.equal(history.points.length, 1);
  assert.equal(history.points[0].day, Math.floor((day - 3 * 86400) / 86400));
  assert.equal(history.points[0].total, 17);
});

test('unknown provider object-property names remain numeric series', () => {
  const history = exactProviderHistory([{ breakdown: { modelHistory: [model('a', 2, day, '__proto__'), model('b', 3, day, 'constructor')] } }], 7, options);
  assert.equal(history.points[0].total, 5);
  assert.equal(history.points[0].values.__proto__, 2);
  assert.equal(history.points[0].values.constructor, 3);
});

test('profile read repairs stored overlap and leaderboards distinguish same model on different providers', async () => {
  const at = Math.floor(Date.now() / 1000 / 86400) * 86400 - 86400;
  const entries = [{ handle: 'repair', tokensAll: 100, breakdown: { models: [{ model: 'x', provider: 'openai', tokensAll: 100 }], daily: [point(10, at)], modelHistory: [model('old', 10, at), model('Other', 10, at, 'other')] } }, { handle: 'providers', tokensAll: 15, breakdown: { models: [{ model: 'same', provider: 'openai', tokensAll: 15 }], modelHistory: [model('same', 7, at, 'one'), model('same', 8, at, 'two')] } }];
  let writes = 0;
  const env = { LEADERBOARD_BUCKET: { async get(key) { return key === 'leaderboard.json' ? { text: async () => JSON.stringify(entries), etag: '1' } : null; }, async put() { writes++; throw new Error('GET cannot write'); } } };
  const profile = await (await worker.fetch(new Request('https://token-horizon.dev/api/user/repair'), env)).json();
  assert.equal(sum(profile.entry.breakdown, at), 10);
  assert.deepEqual(profile.entry.breakdown.modelHistory.map(row => row.model), ['Other']);
  const leaderboard = await (await worker.fetch(new Request('https://token-horizon.dev/api/leaderboard'), env)).json();
  const split = leaderboard.usageHistory.series.filter(row => row.model === 'same');
  assert.equal(split.length, 2);
  assert.deepEqual(split.map(row => [row.provider, row.total]).sort(), [['one', 7], ['two', 8]]);
  assert.equal(writes, 0);
});
