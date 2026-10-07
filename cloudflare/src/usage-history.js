const numeric = value => {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '' || (typeof value === 'string' && !value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 && result <= Number.MAX_SAFE_INTEGER ? result : null;
};
const array = value => Array.isArray(value) ? value : [];

// Payloads contain snapshots of usage buckets, never increments. Replacing a
// bucket is idempotent; adding a cumulative total to a receipt day is not.
export function mergeBreakdownHistory(incoming = {}, previous = {}, {
  nowSeconds = Date.now() / 1000, maxDays = 130,
  normalizeProvider = value => String(value || 'other')
} = {}) {
  incoming = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {};
  previous = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
  const cutoff = (Math.floor(nowSeconds / 86400) - maxDays) * 86400;
  const point = (value, field = 'day') => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const at = numeric(value[field]), tokens = numeric(value.tokens);
    if (at === null || at < cutoff || at > nowSeconds || tokens === null) return null;
    if (field === 'hour' && (!Number.isInteger(at) || at % 3600 !== 0)) return null;
    const result = { ...value, [field]: at, tokens };
    if (value.cost !== undefined) {
      const cost = numeric(value.cost);
      if (cost === null) delete result.cost; else result.cost = cost;
    }
    return result;
  };
  const points = (values, field = 'day') => {
    const result = new Map();
    // Mixed legacy offsets can describe one chart date twice. Choose one
    // source point per UTC date without rewriting its original epoch.
    for (const value of array(values)) { const row = point(value, field); if (row) result.set(field === 'day' ? Math.floor(row.day / 86400) : row.hour, row); }
    return new Map([...result.values()].map(row => [row[field], row]));
  };
  const merge = (old, next, field = 'day') => new Map([...points(old, field), ...points(next, field)]);
  // Fresh exact points outrank retained points regardless of which of the two
  // native daily arrays carried them. Both arrays describe the same buckets.
  const authoritative = points([...array(previous.history), ...array(previous.daily), ...array(incoming.history), ...array(incoming.daily)]);
  const authoritativeDates = new Map([...authoritative.keys()].map(day => [Math.floor(day / 86400), day]));
  const daily = new Map(authoritative);
  const history = points([...array(previous.history), ...array(incoming.history)].map(value => {
    const chosen = authoritativeDates.get(Math.floor(Number(value?.day) / 86400));
    return chosen === undefined ? value : authoritative.get(chosen);
  }));
  const groups = values => {
    const result = new Map();
    for (const model of array(values)) {
      if (!model || typeof model.model !== 'string' || !model.model) continue;
      const provider = normalizeProvider(model.provider), key = JSON.stringify([provider, model.model]);
      for (const row of points(model.points).values()) {
        if (!result.has(row.day)) result.set(row.day, new Map());
        result.get(row.day).set(key, { model: model.model, provider, point: row });
      }
    }
    return result;
  };
  const byDay = groups(previous.modelHistory), next = groups(incoming.modelHistory);
  // Top models and the membership of Other change between exports. An export
  // replaces the WHOLE grouping for a covered day, including absent models.
  const covered = new Set([...points(incoming.daily).keys(), ...points(incoming.history).keys(), ...next.keys()]);
  const coveredDates = new Set([...covered].map(day => Math.floor(day / 86400)));
  for (const day of byDay.keys()) if (coveredDates.has(Math.floor(day / 86400))) byDay.delete(day);
  for (const day of covered) byDay.set(day, next.get(day) || new Map());

  const chosenDates = new Map([...byDay.keys()].sort((a, b) => a - b).map(day => [Math.floor(day / 86400), day]));
  for (const day of byDay.keys()) {
    const date = Math.floor(day / 86400), chosen = authoritativeDates.get(date) ?? chosenDates.get(date);
    if (chosen !== day) byDay.delete(day);
  }

  for (const [day, total] of authoritative) {
    let group = byDay.get(day) || new Map();
    const sum = [...group.values()].reduce((value, row) => value + row.point.tokens, 0);
    const key = JSON.stringify(['other', 'Other']);
    if (!Number.isFinite(sum) || sum > total.tokens) {
      // Old overlapping top-model/Other groups cannot be disambiguated.
      // Preserve the exact total on its original day without guessing shares.
      group = new Map([[key, { model: 'Other', provider: 'other', point: { ...total, day } }]]);
    } else if (sum < total.tokens) {
      const other = group.get(key);
      // The remainder's cost split is unknown; copying the full daily cost
      // here would double count the known models' costs.
      group.set(key, { model: 'Other', provider: 'other', point: {
        day, tokens: (other?.point.tokens || 0) + total.tokens - sum
      } });
    }
    byDay.set(day, group);
  }
  const models = new Map();
  for (const [day, group] of [...byDay].sort((a, b) => a[0] - b[0])) {
    for (const [key, row] of group) {
      if (!models.has(key)) models.set(key, { model: row.model, provider: row.provider, points: [] });
      models.get(key).points.push({ ...row.point, day });
    }
  }
  const out = { ...incoming,
    modelHistory: [...models.values()],
    daily: [...daily.values()].sort((a, b) => a.day - b.day),
    history: [...history.values()].sort((a, b) => a.day - b.day).slice(-10)
  };
  if (Array.isArray(incoming.hourlyHistory) || Array.isArray(previous.hourlyHistory)) {
    out.hourlyHistory = [...merge(previous.hourlyHistory, incoming.hourlyHistory, 'hour').values()].sort((a, b) => a.hour - b.hour);
  }
  return out;
}

export const reconcileBreakdownHistory = (breakdown, options) => mergeBreakdownHistory(breakdown, {}, options);

// Publication/ranking snapshots are cumulative observations. They cannot
// recover usage dates, even by differencing successive syncs.
export function exactProviderHistory(entries, days, { nowSeconds = Date.now() / 1000, normalizeProvider = value => String(value || 'other') } = {}) {
  const end = Math.floor(nowSeconds / 86400), start = end - days + 1;
  const byDay = new Map(), providers = new Set();
  for (const entry of entries) {
    const breakdown = reconcileBreakdownHistory(entry.breakdown, { nowSeconds, normalizeProvider });
    for (const model of breakdown.modelHistory) {
      const provider = normalizeProvider(model.provider);
      for (const point of model.points) {
        const day = Math.floor(point.day / 86400);
        if (day < start || day > end || point.tokens === 0) continue;
        if (!byDay.has(day)) byDay.set(day, Object.create(null));
        const bucket = byDay.get(day);
        bucket[provider] = (bucket[provider] || 0) + point.tokens;
        providers.add(provider);
      }
    }
  }
  const orderedProviders = [...providers].sort();
  const points = [...byDay].sort((a, b) => a[0] - b[0]).map(([day, bucket]) => {
    const values = Object.fromEntries(orderedProviders.map(provider => [provider, bucket[provider] || 0]));
    return { day, date: new Date(day * 86400000).toISOString().slice(0, 10), values, total: Object.values(values).reduce((a, b) => a + b, 0) };
  });
  return { providers: orderedProviders, points };
}
