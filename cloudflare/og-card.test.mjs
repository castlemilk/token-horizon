import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOgModel, renderProfileOgSvg, renderRestrictedOgSvg, ogDay } from './src/og-card.js';

const date = '2026-09-27';
const day = Date.parse(date) / 86400000;
const entry = {
  handle: 'orbit', team: 'Crew', hardware: 'M4 Max', updatedAt: day * 86400 + 40000,
  tokensAll: 34567890, tokens7d: 234567, tokensToday: 12567, streakDays: 11,
  costAll: 123.45,
  breakdown: { daily: [{ day: (day - 2) * 86400, tokens: 10000 }, { day: day * 86400, tokens: 20000 }], models: [{ provider: 'anthropic', tokensAll: 100000 }, { provider: 'openai', tokensAll: 50000 }] }
};
const options = { rank: 3, rankToday: 1, total: 40, standing: { league: 'diamond', title: 'Diamond', division: 2, mmr: 1800 } };

test('calendar normalizes exporter seconds, day indexes, milliseconds and ISO dates', () => {
  for (const value of [date, date + 'T12:00:00Z', day, day * 86400, day * 86400000]) assert.equal(ogDay(value), day);
  for (const value of [undefined, 'invalid', -1, Infinity, 1e308]) assert.equal(ogDay(value), null);
});

test('calendar is a dated 17-week Monday-to-Sunday grid anchored to publication', () => {
  const vm = buildOgModel(entry, options);
  assert.equal(vm.calendarDays.length, 119);
  assert.equal(new Date(vm.calendarStart * 86400000).getUTCDay(), 1);
  assert.equal(vm.calendarEnd, day);
  assert.equal(vm.calendarDays.at(-1).date, date);
  assert.equal(vm.calendarDays.find(row => row.day === day - 1).tokens, 0);
  assert.equal(vm.calendarDays.find(row => row.day === day).tokens, 20000);
  assert.equal(vm.activeDays, 2);
  assert.equal(vm.calendarAvailable, true);
  assert.equal(buildOgModel(entry, options).calendarEnd, day, 'Historical profiles do not shift to today');
});

test('partial final week is not portrayed as zero activity in future dates', () => {
  const vm = buildOgModel({ ...entry, updatedAt: (day - 3) * 86400 }, options);
  assert.equal(vm.calendarDays.at(-1).level, -1);
  assert.equal(vm.calendarDays.at(-1).tokens, 0);
  assert.equal(vm.activeDays, 0, 'Unpublished future rows are excluded');
});

test('calendar prefers canonical daily totals and dedupes rows', () => {
  const vm = buildOgModel({ ...entry, breakdown: { daily: [{ day, tokens: 100 }, { day, tokens: 100 }], modelHistory: [{ points: [{ day, tokens: 999 }] }], history: [{ day, tokens: 999 }] } });
  assert.equal(vm.calendarDays.at(-1).tokens, 100);
});

test('model history fallback sums models once and history fallback preserves gaps', () => {
  const modelVm = buildOgModel({ ...entry, breakdown: { modelHistory: [{ points: [{ day, tokens: 100 }, { day, tokens: 100 }] }, { points: [{ day, tokens: 200 }] }] } });
  assert.equal(modelVm.calendarDays.at(-1).tokens, 300);
  const historyVm = buildOgModel({ ...entry, breakdown: { history: [{ day, tokens: 250 }, { day: day - 2, tokens: 20 }] } });
  assert.equal(historyVm.calendarDays.at(-2).tokens, 0);
  assert.equal(historyVm.calendarDays.at(-1).tokens, 250);
});

test('usage chart keeps 30 chronological days with real gaps and a historical publication anchor', () => {
  const vm = buildOgModel({ ...entry, breakdown: { daily: [
    { day: day + 1, tokens: 999999 },
    { day, tokens: 300 },
    { day: day - 29, tokens: 25 },
    { day: day - 2, tokens: 100 },
    { day: day - 2, tokens: 100 },
    { day: day - 30, tokens: 9000 }
  ] } }, options);
  assert.equal(vm.chartAvailable, true);
  assert.equal(vm.chartDays.length, 30);
  assert.equal(vm.chartDays[0].day, day - 29);
  assert.equal(vm.chartDays.at(-1).date, date);
  for (let index = 1; index < vm.chartDays.length; index++) {
    assert.equal(vm.chartDays[index].day, vm.chartDays[index - 1].day + 1, 'Days do not compress missing activity');
  }
  assert.equal(vm.chartDays.at(-2).tokens, 0);
  assert.equal(vm.chartDays.at(-3).tokens, 100, 'Repeated daily rows are not double counted');
  assert.equal(vm.chartDays.reduce((sum, row) => sum + row.tokens, 0), 425, 'Future and older activity stays outside this chart window');
});

test('chart uses the same canonical source and token privacy rounding as the heatmap', () => {
  const vm = buildOgModel({ ...entry, breakdown: {
    daily: [{ day, tokens: 12345 }],
    modelHistory: [{ points: [{ day, tokens: 999999 }] }],
    history: [{ day, tokens: 888888 }]
  } }, { ...options, fullTokenCounts: false });
  assert.equal(vm.chartDays.at(-1).tokens, 12000);
  assert.equal(vm.chartDays.at(-1).tokens, vm.calendarDays.at(-1).tokens);
  assert.doesNotMatch(renderProfileOgSvg(vm), /12345|12\.35K|999999|888888/);
});

test('usage chart stacks actual daily providers and deduplicates each model before combining them', () => {
  const vm = buildOgModel({ ...entry, breakdown: {
    daily: [{ day, tokens: 1200 }, { day: day - 1, tokens: 400 }],
    // All-time totals intentionally disagree with the published daily sources.
    // They must not be used to invent a daily allocation or its legend.
    models: [{ provider: 'google', tokensAll: 999999999 }],
    modelHistory: [
      { model: 'claude-a', provider: 'anthropic', points: [{ day, tokens: 600 }, { day, tokens: 600 }, { day: day - 1, tokens: 100 }] },
      { model: 'claude-b', provider: 'anthropic', points: [{ day, tokens: 100 }] },
      { model: 'gpt', provider: 'openai', points: [{ day, tokens: 300 }, { day: day - 1, tokens: 300 }] }
    ]
  } }, options);
  assert.equal(vm.chartProviderAvailable, true);
  const latest = vm.chartDays.at(-1);
  assert.equal(latest.tokens, 1200);
  const segments = Object.fromEntries(latest.segments.map(segment => [segment.provider, segment.tokens]));
  assert.deepEqual(segments, { anthropic: 700, openai: 300, unattributed: 200 }, 'Attributed provider counts retain their measured values; only the genuine residual is neutral');
  assert.equal(latest.segments.reduce((sum, segment) => sum + segment.tokens, 0), latest.tokens);
  assert.equal(vm.chartDays.at(-2).segments.find(segment => segment.provider === 'openai').tokens, 300);
  assert.equal(vm.chartProviders.some(provider => provider.provider === 'google'), false, 'All-time mix cannot supply the daily legend');
  for (const segment of latest.segments) {
    const legend = vm.chartProviders.find(provider => provider.provider === segment.provider);
    assert.ok(legend, `${segment.provider} has a chart legend`);
    assert.equal(segment.color, legend.color, 'Bar color matches the same provider in the legend');
    assert.equal(segment.label, legend.label);
  }
  const svg = renderProfileOgSvg(vm);
  assert.match(svg, /data-chart-provider="anthropic"/);
  assert.match(svg, /data-chart-provider="openai"/);
  assert.match(svg, /data-chart-provider="unattributed"/);
});

test('aggregate provider mix cannot invent colors for days without provider history', () => {
  const vm = buildOgModel(entry, options);
  assert.equal(vm.chartAvailable, true);
  assert.equal(vm.chartProviderAvailable, false);
  assert.deepEqual(vm.chartProviders, []);
  assert.ok(vm.chartDays.every(point => point.segments.length === 0));
  const svg = renderProfileOgSvg(vm);
  assert.match(svg, /data-chart-day=/, 'Canonical daily usage remains visible');
  assert.doesNotMatch(svg, /data-chart-provider="(?:anthropic|openai)"/, 'All-time share is never allocated to a daily bar');
});

test('daily attribution exceeding canonical tokens stays neutral instead of scaling measured counts', () => {
  const vm = buildOgModel({ ...entry, breakdown: {
    daily: [{ day, tokens: 1000 }],
    modelHistory: [
      { provider: 'anthropic', points: [{ day, tokens: 900 }] },
      { provider: 'openai', points: [{ day, tokens: 300 }] }
    ]
  } }, options);
  const latest = vm.chartDays.at(-1);
  assert.equal(latest.tokens, 1000);
  assert.ok(latest.segments.every(segment => segment.provider === 'unattributed'), 'An inconsistent day carries no provider labels');
  assert.equal(vm.chartProviders.some(provider => ['anthropic', 'openai'].includes(provider.provider)), false, 'Inconsistent attribution does not enter the daily legend');
  assert.equal(vm.chartProviderAvailable, false);
  assert.doesNotMatch(renderProfileOgSvg(vm), /data-chart-provider="(?:anthropic|openai)"/);
});

test('daily chart groups providers outside its top four into measured Other tokens', () => {
  const providers = ['anthropic', 'openai', 'google', 'kimi', 'deepseek', 'meta'];
  const counts = [600, 500, 400, 300, 200, 100];
  const vm = buildOgModel({ ...entry, breakdown: {
    daily: [{ day, tokens: 2100 }],
    modelHistory: providers.map((provider, index) => ({ provider, points: [{ day, tokens: counts[index] }] }))
  } }, options);
  assert.equal(vm.chartProviders.length, 5);
  assert.deepEqual(new Set(vm.chartProviders.map(provider => provider.provider)), new Set(['anthropic', 'openai', 'google', 'kimi', 'other']));
  assert.equal(vm.chartDays.at(-1).segments.find(segment => segment.provider === 'other').tokens, 300);
  assert.equal(vm.chartDays.at(-1).segments.reduce((sum, segment) => sum + segment.tokens, 0), 2100);
});

test('daily provider fallback uses real model history and ignores activity outside the visible window', () => {
  const vm = buildOgModel({ ...entry, breakdown: { modelHistory: [
    { provider: 'anthropic', points: [{ day, tokens: 700 }] },
    { provider: 'openai', points: [{ day, tokens: 300 }] },
    { provider: 'google', points: [{ day: day - 31, tokens: 99999 }, { day: day + 1, tokens: 99999 }] }
  ] } }, options);
  assert.equal(vm.chartDays.at(-1).tokens, 1000);
  assert.equal(vm.chartProviderAvailable, true);
  assert.equal(vm.chartProviders.some(provider => provider.provider === 'google'), false, 'Older and unpublished future provider activity does not affect this chart legend');
  assert.deepEqual(Object.fromEntries(vm.chartDays.at(-1).segments.map(segment => [segment.provider, segment.tokens])), { anthropic: 700, openai: 300 });
});

test('provider share privacy applies to the chart model, SVG attributes and legend', () => {
  const sharedEntry = { ...entry, breakdown: {
    daily: [{ day, tokens: 12000 }],
    modelHistory: [{ provider: 'anthropic', points: [{ day, tokens: 7000 }] }, { provider: 'openai', points: [{ day, tokens: 5000 }] }]
  } };
  for (const privacy of [{ anonymize: true }, { providerBreakdown: false }]) {
    const vm = buildOgModel(sharedEntry, { ...options, ...privacy });
    assert.equal(vm.chartProviderAvailable, false);
    assert.deepEqual(vm.chartProviders, []);
    assert.ok(vm.chartDays.every(point => point.segments.length === 0), 'Hidden providers do not survive in serialized chart data');
    const svg = renderProfileOgSvg(vm);
    assert.doesNotMatch(svg, /Anthropic|OpenAI|data-chart-provider="(?:anthropic|openai)"/);
    assert.equal(vm.chartDays.at(-1).tokens, 12000, 'Public usage totals remain available independently of hidden providers');
  }
});

test('rounded-token shares do not expose exact daily provider counts', () => {
  const vm = buildOgModel({ ...entry, breakdown: {
    daily: [{ day, tokens: 12345 }],
    modelHistory: [
      { provider: 'anthropic', points: [{ day, tokens: 7890 }] },
      { provider: 'openai', points: [{ day, tokens: 4455 }] }
    ]
  } }, { ...options, fullTokenCounts: false });
  assert.equal(vm.chartDays.at(-1).tokens, 12000);
  for (const segment of vm.chartDays.at(-1).segments) assert.equal(segment.tokens % 1000, 0);
  assert.doesNotMatch(JSON.stringify(vm.chartDays), /7890|4455|12345/);
  assert.doesNotMatch(renderProfileOgSvg(vm), /7\.89K|4\.46K|12\.35K|7890|4455|12345/);
});

test('untrusted daily provider names cannot inject SVG attributes or elements', () => {
  const vm = buildOgModel({ ...entry, breakdown: {
    daily: [{ day, tokens: 1000 }],
    modelHistory: [{ provider: 'odd" onload="alert(1)<script>', points: [{ day, tokens: 1000 }] }]
  } }, options);
  const svg = renderProfileOgSvg(vm);
  assert.doesNotMatch(svg, /<script>|<[^>]*\s(?:onload|onclick)="/);
  assert.doesNotMatch(svg, /NaN|Infinity/);
});

test('missing chart activity remains unavailable even when aggregate totals exist', () => {
  const vm = buildOgModel({ ...entry, breakdown: {} }, options);
  assert.equal(vm.chartAvailable, false);
  assert.ok(vm.chartDays.every(row => row.tokens === 0));
  assert.match(renderProfileOgSvg(vm), /Daily activity not published/);
});

test('usage chart renders above the heatmap beside the preserved profile panel', () => {
  const svg = renderProfileOgSvg(buildOgModel(entry, options));
  assert.match(svg, /data-usage-chart(?:=|\s|>)/);
  const rects = attribute => [...svg.matchAll(new RegExp(`<rect\\b(?=[^>]*\\b${attribute}=")[^>]*>`, 'g'))].map(([tag]) => {
    const get = name => Number(tag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1]);
    return { x: get('x'), y: get('y'), width: get('width'), height: get('height') };
  });
  const bars = rects('data-chart-day').filter(rect => rect.height > 0);
  const cells = rects('data-heatmap-day');
  assert.ok(bars.length > 0, 'Published daily activity has a visible chart');
  assert.equal(cells.length, 119);
  assert.ok(Math.max(...bars.map(rect => rect.y + rect.height)) < Math.min(...cells.map(rect => rect.y)), 'Chart and heatmap occupy separate rows');
  for (const rect of [...bars, ...cells]) {
    assert.ok(rect.x >= 416 && rect.x + rect.width <= 1200, 'Both visuals stay beside the left profile panel');
    assert.ok(rect.y >= 0 && rect.y + rect.height <= 630, 'Both visuals stay inside the social card');
  }
});

test('missing data stays unavailable without inferred hardware or activity', () => {
  const vm = buildOgModel({ handle: 'new', tokensAll: 10, updatedAt: entry.updatedAt });
  assert.equal(vm.hardware, '');
  assert.equal(vm.costAll, null);
  assert.equal(vm.calendarAvailable, false);
  assert.ok(vm.calendarDays.every(row => row.tokens === 0));
  assert.match(renderProfileOgSvg(vm), /Daily activity not published/);
});

test('share options strip rank, identity, provider and cost data from the model', () => {
  const vm = buildOgModel(entry, { ...options, anonymize: true, hideCost: true, includeLeagueRank: false, providerBreakdown: false, fullTokenCounts: false });
  assert.equal(vm.handle, 'Anonymous');
  assert.equal(vm.team, '');
  assert.equal(vm.hardware, '');
  assert.equal(vm.costAll, null);
  assert.equal(vm.tokensToday, 13000);
  assert.deepEqual(vm.mix, []);
  for (const key of ['rank', 'rankToday', 'league', 'division', 'mmr', 'percentile']) assert.equal(key in vm, false);
  const svg = renderProfileOgSvg(vm);
  for (const privateValue of ['@orbit', 'Crew', 'M4 Max', 'Diamond', 'Anthropic', '12.57K']) assert.equal(svg.includes(privateValue), false);
});

test('provider mix includes the remainder and normalizes to a full bar', () => {
  const models = ['anthropic', 'openai', 'google', 'local', 'kimi', 'meta'].map((provider, index) => ({ provider, tokensAll: 100 - index }));
  const vm = buildOgModel({ ...entry, breakdown: { models } });
  assert.equal(vm.mix.length, 5);
  assert.equal(vm.mix.at(-1).provider, 'other');
  assert.ok(Math.abs(vm.mix.reduce((sum, row) => sum + row.share, 0) - 1) < 1e-10);
});

test('unsafe numbers and strings cannot break SVG rendering', () => {
  const vm = buildOgModel({ ...entry, handle: 'a'.repeat(200) + '<script>', team: 'Friends & <script>\u0000', updatedAt: 1e308, tokensAll: Infinity, tokensToday: -1, breakdown: { daily: [{ day, tokens: Infinity }] } }, options);
  assert.equal(vm.tokensAll, 0);
  assert.equal(vm.tokensToday, 0);
  const svg = renderProfileOgSvg(vm);
  assert.doesNotMatch(svg, /<script>|\u0000|NaN|Infinity/);
  assert.match(svg, /&amp; &lt;script&gt;/);
  assert.equal((svg.match(/data-heatmap-day=/g) || []).length, 119);
});

test('restricted preview contains branding and a sign-in invitation only', () => {
  const svg = renderRestrictedOgSvg();
  assert.match(svg, /Private usage report/);
  assert.match(svg, /Sign in to view/);
  assert.doesNotMatch(svg, /@orbit|Crew|34567890|heatmap-day|Diamond/);
});

test('publication milliseconds remain safe for the text renderer and null models are ignored', () => {
  const vm = buildOgModel({ ...entry, updatedAt: entry.updatedAt * 1000, breakdown: { models: [null, { provider: 'anthropic', tokensAll: 100 }] } }, options);
  assert.equal(vm.updatedAt, entry.updatedAt);
  assert.equal(vm.requestsAll, 0);
  assert.equal(vm.mix.length, 1);
  assert.doesNotThrow(() => new Date(vm.updatedAt * 1000).toISOString());
});

test('unknown publication cards never present invented calendar dates', () => {
  const svg = renderProfileOgSvg(buildOgModel({ handle: 'new' }));
  assert.doesNotMatch(svg, /1969|1970|>Sep<|>Oct<|>Nov<|>Dec<|>Jan</);
  assert.match(svg, /Publication date unavailable/);
});
