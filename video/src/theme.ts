// Shared design tokens + helpers for the Token Horizon product film.
// Everything is code-drawn (no raster assets, no webfonts) so renders stay
// fast and hermetic on CI. All per-frame math is O(1); lookup tables are
// module-level so components never allocate inside the frame loop.
export const C = {
  bg: '#060608',
  panel: '#0d0d12',
  line: 'rgba(255,255,255,0.12)',
  text: '#f2f2f5',
  muted: 'rgba(255,255,255,0.55)',
  faint: 'rgba(255,255,255,0.32)',
  accent: '#7c5cff',
  cyan: '#39d5c0',
  green: '#3ddc84',
  orange: '#ff9f43',
  red: '#ff5c5c',
  yellow: '#ffd60a',
} as const;

export const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';
export const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif';

/** Compact token formatter mirroring UsageSnapshot.tokens (1.5k / 2.5M). */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

/** Bar color by used percent — same thresholds as the app. */
export function barColor(pct: number): string {
  if (pct >= 100) return C.red;
  if (pct >= 85) return C.orange;
  return C.green;
}
