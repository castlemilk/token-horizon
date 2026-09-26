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
// a boundary of turn k+1's plan with the same history before it.
//
// This module is backend-agnostic (the state type is a parameter) and
// holds only the store + plan policy; capture/restore live with the
// backend (`qwen35::PrefixState`).

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
    /// `TH_PREFIX_CACHE_ENTRIES` — LRU entry cap (default 4).
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
            max_entries: num("TH_PREFIX_CACHE_ENTRIES", 4),
            max_bytes: num("TH_PREFIX_CACHE_MB", 4096).saturating_mul(1 << 20),
            block: num("TH_PREFIX_CACHE_BLOCK", 128).max(16),
            margin: num("TH_PREFIX_CACHE_MARGIN", 16),
        }
    }

    pub fn disabled() -> Self {
        Self { enabled: false, plan_only: false, max_entries: 0, max_bytes: 0, block: 128, margin: 16 }
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
/// the last turn end (or that fallback) and of the first boundary.
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
        checkpoints.extend(first.and_then(align));
        checkpoints.extend(end);
        splits.extend(extra);
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
        PrefixCacheConfig { enabled: true, plan_only: false, max_entries: entries, max_bytes: bytes, block: 32, margin: 16 }
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
        // 5-token generation prompt → one extra split + checkpoint at 1408
        let p = plan(1432, 512, Some(&c), Some(35), &[1427]);
        assert_eq!(p, ChunkPlan { splits: vec![512, 1024, 1408], checkpoints: vec![1408] });
        assert_eq!(p.history(1408), vec![512, 1024, 1408]);
        assert_eq!(p.history(1407), vec![512, 1024]);
        // the same passage + a longer question shares the 1408 checkpoint
        assert_eq!(plan(1454, 512, Some(&c), Some(35), &[1449]).history(1408), vec![512, 1024, 1408]);
        // bench short prompts: nothing (the step grid = the whole prompt)
        assert_eq!(plan(58, 512, Some(&c), Some(35), &[53]), ChunkPlan::default());
        // multi-turn: turn 2's plan keeps turn 1's end split with the
        // same history before it
        let t1 = plan(1432, 512, Some(&c), Some(35), &[1427]);
        let t2 = plan(2100, 512, Some(&c), Some(35), &[1427, 2090]);
        assert_eq!(t2.splits, vec![512, 1024, 1408, 1536, 2048]);
        assert_eq!(t2.checkpoints, vec![2048]);
        assert_eq!(t2.history(1408), t1.history(1408));
        // a long system prompt: its own split + checkpoint
        let p = plan(2605, 512, Some(&c), Some(2100), &[2600]);
        assert_eq!(p.splits, vec![512, 1024, 1536, 2048, 2560]);
        assert_eq!(p.checkpoints, vec![2048, 2560]);
        // no chat structure: n - margin rounded down (split + checkpoint)
        let p = plan(1000, 512, Some(&c), None, &[]);
        assert_eq!(p, ChunkPlan { splits: vec![512, 896], checkpoints: vec![896] });
        // structure but no turn end (e.g. no generation prompt): the first
        // boundary only
        let p = plan(1000, 512, Some(&c), Some(700), &[]);
        assert_eq!(p, ChunkPlan { splits: vec![512, 640], checkpoints: vec![640] });
        // checkpoints below one block never happen
        assert!(plan(143, 512, Some(&c), None, &[]).checkpoints.is_empty());
        assert_eq!(plan(144, 512, Some(&c), None, &[]).checkpoints, vec![128]);
        // a split on the step grid adds no chunk
        assert_eq!(plan(1100, 512, Some(&c), Some(35), &[1030]).splits, vec![512, 1024]);
    }
}
