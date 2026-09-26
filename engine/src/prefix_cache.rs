// T1 prefix cache — slot-state checkpoints keyed by token prefix.
//
// A checkpoint is a slot's full decode state at an absolute prompt
// position `len` (attention KV rows 0..len, committed GDN recurrent +
// conv state, the DFlash capture rows the draft ring warm-up needs),
// taken during prefill. A later prompt whose first `len` token ids match
// restores it and prefills only the suffix.
//
// Identity by construction. The prefill chunk kernels are NOT row-count
// invariant (split-K tiles below 128 rows, the legacy tile above, the
// fused decode kernels at <= 8), so the bits of the state at `len` depend
// on the chunk boundaries that produced it. Every prompt therefore runs a
// deterministic chunk plan (`plan`) — the prefill-step grid plus splits
// at chat-template turn ends rounded down to `block` — whether or not it
// hits, and each checkpoint stores the boundaries that produced it
// (`history`). A lookup accepts a checkpoint only when the new prompt's
// own plan has exactly those boundaries up to it; the restored request
// then runs the plan's remaining chunks, i.e. exactly what its uncached
// prefill runs: cached and uncached prefills are bit-identical.
//
// Turn ends make the plan prefix-consistent across a conversation: the
// end of the last user/tool message before the generation prompt is also
// a turn end in every later turn's history, so turn k's end checkpoint is
// a boundary of turn k+1's plan with the same history before it. A second
// checkpoint sits on the last step-grid split below the end one: grid
// splits are boundaries of every plan, so a prompt that shares a long
// prefix but not the aligned turn end (another question after the same
// document) still restores up to it.
//
// This module is backend-agnostic (the state type is a parameter) and
// holds only the store + plan policy; capture/restore live with the
// backend (`qwen35::PrefixState`).

/// Default `TH_PREFIX_CACHE_MERGE` (rows).
pub const DEFAULT_MERGE: usize = 1024;

/// Env knobs, read once at engine load.
#[derive(Clone, Copy, Debug)]
pub struct PrefixCacheConfig {
    /// `TH_PREFIX_CACHE=0` disables the cache (default on).
    pub enabled: bool,
    /// `TH_PREFIX_CACHE=miss` (test mode): run the cache's chunk plan but
    /// never restore or capture — every request is an uncached prefill
    /// with exactly the numerics of a cache-on server. A/B reference for
    /// the end-to-end identity check (same request sequence, same
    /// outputs); not a production setting.
    pub plan_only: bool,
    /// `TH_PREFIX_CACHE=grid`: main's chunk plan exactly (the step grid,
    /// no turn-end splits) with one checkpoint at the last grid split
    /// `margin` before the end. Hits and misses are then bit-identical to
    /// a cache-off server (and to main), at the cost of longer suffixes
    /// (up to a step + the tail) on a hit.
    pub grid_only: bool,
    /// `TH_PREFIX_CACHE_ENTRIES` — LRU entry cap (default 8: a prompt
    /// stores up to two — its grid and end checkpoints).
    pub max_entries: usize,
    /// `TH_PREFIX_CACHE_MB` — LRU byte cap in MiB (default 4096).
    pub max_bytes: usize,
    /// `TH_PREFIX_CACHE_BLOCK` — checkpoint alignment: turn-end splits
    /// round down to a multiple of this (default 128). Coarser = more
    /// prompts share a checkpoint (different last questions after a long
    /// shared context) and fewer extra chunks; finer = shorter suffixes.
    pub block: usize,
    /// `TH_PREFIX_CACHE_MARGIN` — without recognised chat turns the end
    /// checkpoint stays at least this many tokens before the end of the
    /// prompt (default 16).
    pub margin: usize,
    /// `TH_PREFIX_CACHE_MERGE` — an off-grid split replaces the grid
    /// split just before it when the merged chunk has at most this many
    /// rows (0: never merge — one extra chunk per turn-end split).
    pub merge: usize,
}

impl PrefixCacheConfig {
    pub fn from_env() -> Self {
        let num = |k: &str, d: usize| {
            std::env::var(k)
                .ok()
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(d)
        };
        let mode = std::env::var("TH_PREFIX_CACHE").ok();
        Self {
            enabled: mode.as_deref() != Some("0"),
            plan_only: mode.as_deref() == Some("miss"),
            grid_only: mode.as_deref() == Some("grid"),
            max_entries: num("TH_PREFIX_CACHE_ENTRIES", 8),
            max_bytes: num("TH_PREFIX_CACHE_MB", 4096).saturating_mul(1 << 20),
            block: num("TH_PREFIX_CACHE_BLOCK", 128).max(16),
            margin: num("TH_PREFIX_CACHE_MARGIN", 16),
            merge: num("TH_PREFIX_CACHE_MERGE", DEFAULT_MERGE),
        }
    }

    pub fn disabled() -> Self {
        Self {
            enabled: false,
            plan_only: false,
            grid_only: false,
            max_entries: 0,
            max_bytes: 0,
            block: 128,
            margin: 16,
            merge: DEFAULT_MERGE,
        }
    }
}

/// Chat-template token ids for the plan policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChatMarks {
    pub im_start: u32,
    pub im_end: u32,
    pub newline: u32,
    pub assistant: u32,
}

/// Message boundaries (positions just past an `<|im_end|>` `\n` pair):
/// (the first one, the turn ends — boundaries followed by
/// `<|im_start|>` `assistant`, i.e. the end of each turn's last user /
/// tool message, including the one before the generation prompt).
pub fn chat_boundaries(tokens: &[u32], m: &ChatMarks) -> (Option<usize>, Vec<usize>) {
    let mut first = None;
    let mut turn_ends = Vec::new();
    for b in 2..=tokens.len() {
        if tokens[b - 2] != m.im_end || tokens[b - 1] != m.newline {
            continue;
        }
        first.get_or_insert(b);
        if tokens.get(b) == Some(&m.im_start) && tokens.get(b + 1) == Some(&m.assistant) {
            turn_ends.push(b);
        }
    }
    (first, turn_ends)
}

/// A prompt's prefill chunk plan.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChunkPlan {
    /// Chunk boundaries strictly inside (0, n), ascending.
    pub splits: Vec<usize>,
    /// The splits worth checkpointing (the end checkpoint + a long first
    /// message's), ascending.
    pub checkpoints: Vec<usize>,
}

impl ChunkPlan {
    /// The boundaries at or below `len` — what a checkpoint at `len`
    /// was computed through.
    pub fn history(&self, len: usize) -> Vec<usize> {
        self.splits.iter().copied().filter(|&s| s <= len).collect()
    }
}

/// Plan for a prompt of `n` tokens: the `step` grid (the plain chunked
/// prefill), plus — with the cache on — `block`-aligned splits at the
/// first message boundary and at every turn end; with no recognised chat
/// structure, one split at `n - margin` rounded down (then only exact
/// repeats and same-length prompts share it). Checkpoints: the split of
/// the last turn end (or that fallback), of the first boundary, and the
/// last grid split below the end one (below `n - margin` without one) —
/// no extra chunk, and shared by every prompt with the same first tokens
/// up to it. An extra split off the grid replaces the grid split just
/// before it when the merged chunk stays within `merge` rows, so the plan
/// has main's chunk count (the prefill cost of a miss is unchanged).
pub fn plan(
    n: usize,
    step: usize,
    cache: Option<&PrefixCacheConfig>,
    first: Option<usize>,
    turn_ends: &[usize],
) -> ChunkPlan {
    let step = step.max(1);
    let mut splits: Vec<usize> = (1..).map(|k| k * step).take_while(|&s| s < n).collect();
    let mut checkpoints = Vec::new();
    if let Some(c) = cache.filter(|c| c.grid_only) {
        // main's chunks; the last grid split at least `margin` before the end
        let grid = n.saturating_sub(c.margin).saturating_sub(1) / step * step;
        if grid > 0 {
            checkpoints.push(grid);
        }
        return ChunkPlan { splits, checkpoints };
    }
    if let Some(c) = cache.filter(|c| c.block > 0) {
        let g = c.block;
        let align = |b: usize| (b / g * g > 0 && b / g * g < n).then_some(b / g * g);
        let mut extra: Vec<usize> = first.iter().chain(turn_ends).filter_map(|&b| align(b)).collect();
        let end = match turn_ends.last() {
            Some(&b) => align(b),
            None if first.is_none() => align(n.saturating_sub(c.margin)),
            None => None,
        };
        if first.is_none() && turn_ends.is_empty() {
            extra.extend(end);
        }
        extra.sort_unstable();
        extra.dedup();
        splits.extend(extra.iter().copied());
        splits.sort_unstable();
        splits.dedup();
        // keep main's chunk count: an extra split off the grid adds a chunk
        // (one more weight sweep — ~3% of a 1.4k-8k prefill), so drop the
        // grid split just before it when the merged chunk stays within
        // `merge` rows (large merged chunks can cost more than the sweep).
        // Decided from boundaries at or below the extra split only, so the
        // plan stays prefix-consistent (a checkpoint's history is the same
        // in every prompt that shares the tokens up to it).
        let orig = splits.clone();
        let dropped: Vec<usize> = extra
            .iter()
            .filter(|&&e| e % step != 0)
            .filter_map(|&e| {
                let i = orig.iter().position(|&s| s == e)?;
                let before = *orig.get(i.checked_sub(1)?)?;
                let prev = i.checked_sub(2).map_or(0, |j| orig[j]);
                (before % step == 0 && !extra.contains(&before) && c.merge > 0 && e - prev <= c.merge)
                    .then_some(before)
            })
            .collect();
        splits.retain(|s| !dropped.contains(s));
        checkpoints.extend(first.and_then(align));
        checkpoints.extend(end);
        // the last surviving grid split below the end one (below n - margin
        // without one): a boundary of every plan that shares the prefix
        let limit = end.unwrap_or(n.saturating_sub(c.margin));
        if let Some(&grid) = splits.iter().rev().find(|&&s| s % step == 0 && s < limit) {
            checkpoints.push(grid);
        }
    }
    splits.sort_unstable();
    splits.dedup();
    checkpoints.sort_unstable();
    checkpoints.dedup();
    ChunkPlan { splits, checkpoints }
}

struct Entry<S> {
    tokens: Vec<u32>,
    step: usize,
    history: Vec<usize>,
    bytes: usize,
    last_used: u64,
    state: S,
}

/// LRU store of checkpoints (a handful of entries — linear scans).
pub struct PrefixCache<S> {
    cfg: PrefixCacheConfig,
    entries: Vec<Entry<S>>,
    bytes: usize,
    tick: u64,
}

/// A store mutation, for the caller's counters.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct InsertOutcome {
    pub inserted: bool,
    pub evicted: usize,
}

impl<S> PrefixCache<S> {
    pub fn new(cfg: PrefixCacheConfig) -> Self {
        Self { cfg, entries: Vec::new(), bytes: 0, tick: 0 }
    }

    pub fn config(&self) -> PrefixCacheConfig {
        self.cfg
    }

    pub fn enabled(&self) -> bool {
        self.cfg.enabled && self.cfg.max_entries > 0 && self.cfg.max_bytes > 0
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    fn touch(&mut self, i: usize) {
        self.tick += 1;
        self.entries[i].last_used = self.tick;
    }

    /// Longest checkpoint that prefixes `prompt`, is at most `max_len`
    /// long, and was computed through exactly `plan`'s boundaries (under
    /// the same prefill `step`). Touches every usable match, not just the
    /// longest: a shared shorter checkpoint (a system prompt) is in use
    /// while longer per-conversation ones are, and must not age out first.
    pub fn lookup(&mut self, prompt: &[u32], step: usize, plan: &ChunkPlan, max_len: usize) -> Option<(usize, &S)> {
        let usable: Vec<usize> = (0..self.entries.len())
            .filter(|&i| {
                let e = &self.entries[i];
                let n = e.tokens.len();
                e.step == step
                    && n > 0
                    && n <= max_len
                    && n <= prompt.len()
                    && prompt[..n] == e.tokens[..]
                    && plan.history(n) == e.history
            })
            .collect();
        let best = *usable.iter().max_by_key(|&&i| self.entries[i].tokens.len())?;
        // shorter matches first, the one returned last (most recent)
        let mut order = usable;
        order.sort_by_key(|&i| self.entries[i].tokens.len());
        for i in order {
            self.touch(i);
        }
        let e = &self.entries[best];
        Some((e.tokens.len(), &e.state))
    }

    fn position(&self, tokens: &[u32], step: usize, history: &[usize]) -> Option<usize> {
        self.entries
            .iter()
            .position(|e| e.step == step && e.tokens == tokens && e.history == history)
    }

    /// Is this exact checkpoint (tokens, step, history) stored? Touches it.
    pub fn contains(&mut self, tokens: &[u32], step: usize, history: &[usize]) -> bool {
        match self.position(tokens, step, history) {
            Some(i) => {
                self.touch(i);
                true
            }
            None => false,
        }
    }

    /// Insert a checkpoint (replacing the same tokens + step + history),
    /// then evict least recently used entries until both caps hold. An
    /// entry larger than the byte cap on its own is not stored.
    pub fn insert(&mut self, tokens: Vec<u32>, step: usize, history: Vec<usize>, bytes: usize, state: S) -> InsertOutcome {
        let mut out = InsertOutcome::default();
        if !self.enabled() || bytes > self.cfg.max_bytes || tokens.is_empty() {
            return out;
        }
        if let Some(i) = self.position(&tokens, step, &history) {
            let old = self.entries.swap_remove(i);
            self.bytes -= old.bytes;
        }
        self.tick += 1;
        self.entries.push(Entry { tokens, step, history, bytes, last_used: self.tick, state });
        self.bytes += bytes;
        out.inserted = true;
        while self.entries.len() > self.cfg.max_entries || self.bytes > self.cfg.max_bytes {
            // never evict the entry just inserted (it fits on its own)
            let newest = self.tick;
            let Some(i) = self
                .entries
                .iter()
                .enumerate()
                .filter(|(_, e)| e.last_used != newest)
                .min_by_key(|(_, e)| e.last_used)
                .map(|(i, _)| i)
            else {
                break;
            };
            let old = self.entries.swap_remove(i);
            self.bytes -= old.bytes;
            out.evicted += 1;
        }
        out
    }

    /// Drop every entry; returns how many were dropped.
    pub fn clear(&mut self) -> usize {
        let n = self.entries.len();
        self.entries.clear();
        self.bytes = 0;
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(entries: usize, bytes: usize) -> PrefixCacheConfig {
        PrefixCacheConfig {
            enabled: true,
            plan_only: false,
            grid_only: false,
            max_entries: entries,
            max_bytes: bytes,
            block: 32,
            margin: 16,
            merge: 1024,
        }
    }

    /// Grid-only plan (no chat structure, no fallback reach) for store tests.
    fn grid(n: usize, step: usize) -> ChunkPlan {
        plan(n, step, None, None, &[])
    }

    #[test]
    fn lookup_picks_longest_matching_prefix_within_limits() {
        let mut c: PrefixCache<u32> = PrefixCache::new(cfg(8, 1000));
        let p: Vec<u32> = (0..100).collect();
        let g = grid(100, 32);
        for len in [32usize, 64, 96] {
            c.insert(p[..len].to_vec(), 32, g.history(len), 1, len as u32);
        }
        let mut other = p[..64].to_vec();
        other[40] = 999; // diverges inside the 64 checkpoint
        c.insert(other.clone(), 32, g.history(64), 1, 640);
        assert_eq!(c.lookup(&p, 32, &g, 99).map(|(n, s)| (n, *s)), Some((96, 96)));
        // max_len excludes the 96 entry (the suffix must be non-empty)
        assert_eq!(c.lookup(&p[..96], 32, &grid(96, 32), 95).map(|(n, s)| (n, *s)), Some((64, 64)));
        // a prompt diverging at 40 only matches the 32 entry
        let mut q = p.clone();
        q[40] = 7;
        assert_eq!(c.lookup(&q, 32, &g, 99).map(|(n, _)| n), Some(32));
        other.extend([1, 2, 3]);
        assert_eq!(c.lookup(&other, 32, &grid(67, 32), 66).map(|(n, s)| (n, *s)), Some((64, 640)));
        // a different prefill step never matches (different chunk plan)
        assert!(c.lookup(&p, 64, &grid(100, 64), 99).is_none());
        assert!(c.lookup(&p[..20], 32, &grid(20, 32), 19).is_none());
    }

    #[test]
    fn lookup_requires_the_same_chunk_history() {
        let mut c: PrefixCache<u8> = PrefixCache::new(cfg(8, 1000));
        let p: Vec<u32> = (0..1500).map(|i| i % 251).collect();
        // checkpoint at 1408 computed through [512, 1024, 1408]
        c.insert(p[..1408].to_vec(), 512, vec![512, 1024, 1408], 1, 1);
        let ok = ChunkPlan { splits: vec![512, 1024, 1408], checkpoints: vec![1408] };
        assert_eq!(c.lookup(&p, 512, &ok, 1499).map(|(n, _)| n), Some(1408));
        // same tokens, but this prompt's plan splits at 1280 first: its
        // uncached prefill never had a boundary at 1408 → no hit
        let other = ChunkPlan { splits: vec![512, 1024, 1280, 1536], checkpoints: vec![1280] };
        assert!(c.lookup(&p, 512, &other, 1499).is_none());
        // ... or has an extra boundary before it
        let extra = ChunkPlan { splits: vec![512, 768, 1024, 1408], checkpoints: vec![1408] };
        assert!(c.lookup(&p, 512, &extra, 1499).is_none());
    }

    #[test]
    fn lookup_touches_shorter_matches() {
        let mut c: PrefixCache<u8> = PrefixCache::new(cfg(3, 1000));
        let p: Vec<u32> = (0..300).collect();
        let g = grid(300, 32);
        c.insert(p[..64].to_vec(), 32, g.history(64), 1, 64); // shared "system prompt"
        c.insert(p[..128].to_vec(), 32, g.history(128), 1, 128);
        let mut q = p[..64].to_vec();
        q.extend(1000..1100u32); // another conversation, same system prompt
        c.insert(q[..96].to_vec(), 32, g.history(96), 1, 96);
        // a hit on the 128 entry also refreshes the 64 one: the next insert
        // evicts the other conversation's 96, not the shared 64
        assert_eq!(c.lookup(&p, 32, &g, 299).map(|(n, _)| n), Some(128));
        c.insert(p[..192].to_vec(), 32, g.history(192), 1, 192);
        assert!(c.contains(&p[..64], 32, &g.history(64)));
        assert!(!c.contains(&q[..96], 32, &g.history(96)));
        // same tokens under another history is a different checkpoint
        assert!(!c.contains(&p[..128], 32, &[32, 64, 100, 128]));
    }

    #[test]
    fn lru_eviction_by_count_and_bytes() {
        let mut c: PrefixCache<u8> = PrefixCache::new(cfg(2, 100));
        let t = |k: u32| vec![k; 4];
        let g = grid(8, 512);
        assert_eq!(c.insert(t(1), 1, vec![], 10, 1), InsertOutcome { inserted: true, evicted: 0 });
        c.insert(t(2), 1, vec![], 10, 2);
        // touch 1 → 2 becomes LRU
        assert!(c.lookup(&[1, 1, 1, 1, 0], 1, &g, 99).is_some());
        assert_eq!(c.insert(t(3), 1, vec![], 10, 3).evicted, 1);
        assert!(c.contains(&t(1), 1, &[]) && c.contains(&t(3), 1, &[]) && !c.contains(&t(2), 1, &[]));
        // byte cap: a 90-byte entry evicts both others
        let mut c: PrefixCache<u8> = PrefixCache::new(cfg(8, 100));
        c.insert(t(1), 1, vec![], 30, 1);
        c.insert(t(2), 1, vec![], 30, 2);
        assert_eq!(c.insert(t(3), 1, vec![], 90, 3).evicted, 2);
        assert_eq!((c.len(), c.bytes()), (1, 90));
        // larger than the cap alone: not stored, nothing evicted
        assert_eq!(c.insert(t(4), 1, vec![], 101, 4), InsertOutcome::default());
        assert_eq!((c.len(), c.bytes()), (1, 90));
    }

    #[test]
    fn reinsert_replaces_and_disabled_stores_nothing() {
        let mut c: PrefixCache<u8> = PrefixCache::new(cfg(4, 100));
        c.insert(vec![1, 2], 1, vec![], 10, 1);
        c.insert(vec![1, 2], 1, vec![], 20, 2);
        assert_eq!((c.len(), c.bytes()), (1, 20));
        assert_eq!(c.lookup(&[1, 2, 3], 1, &grid(3, 512), 9).map(|(_, s)| *s), Some(2));
        assert_eq!(c.clear(), 1);
        assert_eq!((c.len(), c.bytes()), (0, 0));
        let mut d: PrefixCache<u8> = PrefixCache::new(PrefixCacheConfig::disabled());
        assert!(!d.insert(vec![1], 1, vec![], 1, 1).inserted);
        assert!(d.lookup(&[1, 2], 1, &grid(2, 512), 9).is_none());
    }

    /// Two questions after the same long document: the end checkpoints
    /// differ (block-aligned turn ends 7424 vs 7552), the grid checkpoint
    /// below them is shared — the second question restores 6656 (7168 is
    /// merged away in both plans) instead of missing, and an exact repeat
    /// of either restores its own end.
    #[test]
    fn grid_checkpoint_serves_a_different_question() {
        let c = PrefixCacheConfig { block: 128, ..cfg(8, 1 << 30) };
        let mut store: PrefixCache<u8> = PrefixCache::new(c);
        let doc: Vec<u32> = (0..7540).map(|i| 100 + i % 997).collect();
        let a: Vec<u32> = doc.iter().copied().chain(1..=10).collect(); // n 7550, turn end 7545
        let b: Vec<u32> = doc.iter().copied().chain(20..40).collect(); // n 7560, turn end 7555
        let (pa, pb) = (plan(a.len(), 512, Some(&c), Some(35), &[7545]), plan(b.len(), 512, Some(&c), Some(35), &[7555]));
        for &ck in &pa.checkpoints {
            store.insert(a[..ck].to_vec(), 512, pa.history(ck), 1, ck as u8);
        }
        assert_eq!(store.lookup(&b, 512, &pb, b.len() - 1).map(|(n, _)| n), Some(6656));
        assert_eq!(store.lookup(&a, 512, &pa, a.len() - 1).map(|(n, _)| n), Some(7424));
        for &ck in &pb.checkpoints {
            store.insert(b[..ck].to_vec(), 512, pb.history(ck), 1, 0);
        }
        // b's grid checkpoint is a's (same tokens, step, history): replaced, not duplicated
        assert_eq!(store.len(), 3);
        assert_eq!(store.lookup(&b, 512, &pb, b.len() - 1).map(|(n, _)| n), Some(7552));
    }

    /// TH_PREFIX_CACHE=grid: the plain step grid (main's chunks) whatever
    /// the chat structure, one checkpoint at the last grid split `margin`
    /// before the end — so hit, miss and cache-off prefill the same chunks.
    #[test]
    fn grid_mode_keeps_mains_chunks() {
        let g = PrefixCacheConfig { grid_only: true, block: 128, ..cfg(8, 1 << 30) };
        for (n, first, ends, ck) in [
            (1432usize, Some(35usize), vec![1427usize], vec![1024usize]),
            (7550, Some(35), vec![7545], vec![7168]),
            (1030, None, vec![], vec![512]),
            (2605, Some(2100), vec![2600], vec![2560]),
            (500, Some(35), vec![495], vec![]),
        ] {
            let p = plan(n, 512, Some(&g), first, &ends);
            assert_eq!(p.splits, plan(n, 512, None, None, &[]).splits, "n={n}: grid mode must keep main's chunks");
            assert_eq!(p.checkpoints, ck, "n={n}");
        }
        // a grid checkpoint is shared by the same document with another question
        let (a, b) = (plan(1432, 512, Some(&g), Some(35), &[1427]), plan(1454, 512, Some(&g), Some(35), &[1449]));
        assert_eq!(a.history(1024), b.history(1024));
    }

    const M: ChatMarks = ChatMarks { im_start: 7, im_end: 9, newline: 5, assistant: 3 };

    #[test]
    fn chat_boundaries_first_and_turn_ends() {
        // [sys ... <e>\n][<s> user ... <e>\n][<s> assistant ... <e>\n][<s> user .. <e>\n][<s> assistant \n]
        let t = [7, 1, 1, 9, 5, 7, 2, 2, 9, 5, 7, 3, 4, 9, 5, 7, 2, 9, 5, 7, 3, 5];
        let (first, ends) = chat_boundaries(&t, &M);
        assert_eq!(first, Some(5));
        assert_eq!(ends, vec![10, 19]);
        assert_eq!(chat_boundaries(&[1, 2, 3], &M), (None, vec![]));
        // a boundary at the very end is a boundary but not a turn end
        assert_eq!(chat_boundaries(&[1, 9, 5], &M), (Some(3), vec![]));
    }

    #[test]
    fn plan_policy() {
        let c = PrefixCacheConfig { block: 128, ..cfg(4, 1 << 30) };
        // cache off / no structure reach: the plain step grid
        assert_eq!(plan(1432, 512, None, Some(35), &[1427]).splits, vec![512, 1024]);
        assert!(plan(1432, 512, None, Some(35), &[1427]).checkpoints.is_empty());
        // bench ctx1500 shape: 35-token system, user message ends at 1427,
        // 5-token generation prompt → a split + checkpoint at 1408 that
        // replaces the grid split 1024 (main's 3 chunks: [0,512) [512,1408)
        // [1408,1432)), grid checkpoint at 512
        let p = plan(1432, 512, Some(&c), Some(35), &[1427]);
        assert_eq!(p, ChunkPlan { splits: vec![512, 1408], checkpoints: vec![512, 1408] });
        assert_eq!(p.splits.len(), plan(1432, 512, None, None, &[]).splits.len(), "main's chunk count");
        assert_eq!(p.history(1408), vec![512, 1408]);
        assert_eq!(p.history(1407), vec![512]);
        // the same passage + a longer question shares the 1408 checkpoint
        assert_eq!(plan(1454, 512, Some(&c), Some(35), &[1449]).history(1408), vec![512, 1408]);
        // bench short prompts: nothing (the step grid = the whole prompt)
        assert_eq!(plan(58, 512, Some(&c), Some(35), &[53]), ChunkPlan::default());
        // multi-turn: turn 2's plan keeps turn 1's end split with the
        // same history before it
        let t1 = plan(1432, 512, Some(&c), Some(35), &[1427]);
        let t2 = plan(2100, 512, Some(&c), Some(35), &[1427, 2090]);
        assert_eq!(t2.splits, vec![512, 1408, 1536, 2048]);
        assert_eq!(t2.checkpoints, vec![1536, 2048]);
        assert_eq!(t2.history(1408), t1.history(1408));
        let t3 = plan(2700, 512, Some(&c), Some(35), &[1427, 2090, 2690]);
        assert_eq!(t3.splits, vec![512, 1408, 1536, 2048, 2688]);
        assert_eq!((t3.history(1408), t3.history(2048)), (t1.history(1408), t2.history(2048)));
        // a long system prompt: its own split + checkpoint
        let p = plan(2605, 512, Some(&c), Some(2100), &[2600]);
        assert_eq!(p.splits, vec![512, 1024, 1536, 2048, 2560]);
        assert_eq!(p.checkpoints, vec![2048, 2560]);
        // no chat structure: n - margin rounded down (split + checkpoint,
        // merged with the grid split before it)
        let p = plan(1000, 512, Some(&c), None, &[]);
        assert_eq!(p, ChunkPlan { splits: vec![896], checkpoints: vec![896] });
        // structure but no turn end (e.g. no generation prompt): the first
        // boundary
        let p = plan(1000, 512, Some(&c), Some(700), &[]);
        assert_eq!(p, ChunkPlan { splits: vec![640], checkpoints: vec![640] });
        // 8k document, two questions: different aligned turn ends (7424 vs
        // 7552 → no shared end checkpoint), one shared grid checkpoint
        let (a, b) = (plan(7550, 512, Some(&c), Some(35), &[7545]), plan(7560, 512, Some(&c), Some(35), &[7555]));
        assert_eq!((a.checkpoints.clone(), b.checkpoints.clone()), (vec![6656, 7424], vec![6656, 7552]));
        assert_eq!(a.history(6656), b.history(6656));
        assert_eq!(a.splits.len(), plan(7550, 512, None, None, &[]).splits.len(), "main's chunk count");
        // two extra splits in one grid interval: only the first merges
        let p = plan(1500, 512, Some(&c), Some(1100), &[1300]);
        assert_eq!(p.splits, vec![512, 1024, 1280]);
        // short prompts: no grid checkpoint either
        assert!(plan(600, 512, Some(&c), Some(35), &[595]).checkpoints == vec![512]);
        // checkpoints below one block never happen
        assert!(plan(143, 512, Some(&c), None, &[]).checkpoints.is_empty());
        assert_eq!(plan(144, 512, Some(&c), None, &[]).checkpoints, vec![128]);
        // a split on the step grid adds no chunk
        assert_eq!(plan(1100, 512, Some(&c), Some(35), &[1030]).splits, vec![512, 1024]);
    }

    /// TH_PREFIX_CACHE_MERGE bounds the merged chunk: 0 never merges (an
    /// extra chunk per turn-end split), 768 merges the 8k document's
    /// [6656, 7424) but not the 1.4k passage's [512, 1408). Merging makes
    /// the grid checkpoint depend on the turn end: two questions after the
    /// same 8k document share it in both orders only when both plans make
    /// the same merge decision (1024: both drop 7168 → 6656; 0: both keep
    /// it → 7168); at 768 the 7560-token prompt keeps 7168 while the
    /// 7550-token one drops it, so 7560 first → 7550 misses.
    #[test]
    fn merge_limit() {
        let c = |merge| PrefixCacheConfig { block: 128, merge, ..cfg(8, 1 << 30) };
        let splits = |n, merge, ends: &[usize]| plan(n, 512, Some(&c(merge)), Some(35), ends).splits;
        assert_eq!(splits(1432, 1024, &[1427]), vec![512, 1408]);
        assert_eq!(splits(1432, 768, &[1427]), vec![512, 1024, 1408]);
        assert_eq!(splits(1432, 0, &[1427]), vec![512, 1024, 1408]);
        let grid8k: Vec<usize> = (1..=13).map(|k| k * 512).collect();
        let with = |tail: &[usize]| grid8k.iter().copied().chain(tail.iter().copied()).collect::<Vec<_>>();
        assert_eq!(splits(7550, 768, &[7545]), with(&[7424]));
        assert_eq!(splits(7550, 0, &[7545]), with(&[7168, 7424]));
        // 7560's turn end aligns to 7552: [6656, 7552) = 896 rows > 768 keeps 7168
        assert_eq!(splits(7560, 768, &[7555]), with(&[7168, 7552]));
        let doc: Vec<u32> = (0..7540).map(|i| 100 + i % 997).collect();
        let a: Vec<u32> = doc.iter().copied().chain(1..=10).collect(); // n 7550, turn end 7545
        let b: Vec<u32> = doc.iter().copied().chain(20..40).collect(); // n 7560, turn end 7555
        // (merge, hit length for b after a, hit length for a after b)
        for (merge, ab, ba) in [(1024, Some(6656), Some(6656)), (0, Some(7168), Some(7168)), (768, Some(6656), None)] {
            let cc = c(merge);
            let (pa, pb) = (plan(a.len(), 512, Some(&cc), Some(35), &[7545]), plan(b.len(), 512, Some(&cc), Some(35), &[7555]));
            let hit = |first: (&[u32], &ChunkPlan), second: (&[u32], &ChunkPlan)| {
                let mut st: PrefixCache<u8> = PrefixCache::new(cc);
                for &ck in &first.1.checkpoints {
                    st.insert(first.0[..ck].to_vec(), 512, first.1.history(ck), 1, 0);
                }
                st.lookup(second.0, 512, second.1, second.0.len() - 1).map(|(n, _)| n)
            };
            assert_eq!(hit((&a, &pa), (&b, &pb)), ab, "merge {merge}: a then b");
            assert_eq!(hit((&b, &pb), (&a, &pa)), ba, "merge {merge}: b then a");
        }
    }
}
