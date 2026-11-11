/**
 * Hidden constants of rlc-response-lab. Single source for the checks, the
 * fixtures and the tests. Nothing here may appear in the prompt (checks.test.ts
 * enforces this for the literal values). Rotate by bumping HIDDEN_VERSION.
 */
// v2: the prompt's capacitance range is now 1e-9 to 1e6 (the hidden C of 3.9e-9 needs it); values unchanged.
export const HIDDEN_VERSION = 'rlc-response-lab/v2'

export interface SeriesSet {
  R: number
  L: number
  C: number
}

/**
 * Named circuits. Names follow the check method text. OVM is the metrics
 * overdamped set (zeta 40.003); OVS is the step overdamped set (zeta 3).
 */
export const SET = {
  U1: { R: 47, L: 0.022, C: 3.3e-7 },
  U2: { R: 160, L: 0.1, C: 1e-5 },
  CR: { R: 2, L: 0.25, C: 0.25 },
  NC: { R: 200.0000001, L: 0.01, C: 1e-6 },
  NU: { R: 200.00002, L: 0.01, C: 1e-6 },
  ND: { R: 199.99998, L: 0.01, C: 1e-6 },
  OVM: { R: 2530, L: 0.001, C: 1e-6 },
  OVS: { R: 600, L: 0.01, C: 1e-6 },
  VR_UNDER: { R: 1, L: 0.01, C: 1e-6 },
  BA_HF: { R: 10, L: 1e-6, C: 5e-9 },
  READ_A: { R: 33, L: 0.01, C: 2.53318e-6 },
} as const satisfies Record<string, SeriesSet>

/** Metrics sweep (rlc-metrics), in order. */
export const METRIC_SETS: SeriesSet[] = [SET.U1, SET.U2, SET.CR, SET.NC, SET.NU, SET.ND, SET.OVM]

/** Peak and overshoot sweep (rlc-peak-overshoot): zeta values; L and C fixed, R = 2 zeta sqrt(L/C). */
export const PEAK_ZETAS = [0.005, 0.1, 0.4, 0.625, 0.8, 3] as const
export const PEAK_L = 0.01
export const PEAK_C = 1e-6

/** Response sweep (rlc-response): frequencies as multiples of f0. */
export const RESPONSE_MULTIPLES = [0.1, 0.7, 1, 1.3, 20] as const

/** Step underdamped sweep (rlc-step-underdamped): multiples of 2L/R. */
export const STEP_UNDER_MULTIPLES = [0, 0.13, 0.5, 1, 2.7, 6] as const

/** Underdamped step sweep (rlc-step-underdamped): U1 and the zeta = 0.005 set, each with its own 2L/R. */
export const STEP_UNDER_SETS: SeriesSet[] = [SET.U1, SET.VR_UNDER]

/** Critical and overdamped sweep (rlc-step-critical-overdamped): multiples of tau. */
export const STEP_CRIT_MULTIPLES = [0, 0.2, 1, 3, 8] as const
export const STEP_CRIT_SETS: SeriesSet[] = [SET.CR, SET.NC, SET.NU, SET.ND, SET.OVM, SET.OVS]

/** Bode curve sweep (rlc-bode-curve): set and output pairs. */
export const BODE_CURVE_CASES: Array<{ set: SeriesSet; output: 'C' | 'R' }> = [
  { set: SET.U1, output: 'C' },
  { set: SET.U2, output: 'R' },
]

/** Auto-range sweep (rlc-bode-autorange), output C. */
export const AUTORANGE_SETS: SeriesSet[] = [SET.CR, SET.BA_HF, SET.U1]

/** Peak resolution (rlc-peak-resolved): L and C pairs; R = sqrt(L/C)/100 (Q = 100). */
export const PEAK_RESOLVED_LC: Array<{ L: number; C: number }> = [
  { L: 4.7e-3, C: 2.2e-8 },
  { L: 0.33, C: 6.8e-7 },
  { L: 0.047, C: 1e-7 },
  { L: 1.5e-4, C: 3.9e-9 },
  { L: 8.2, C: 4.7e-6 },
]
export const PEAK_RESOLVED_Q_DIVISOR = 100

/** Step plot (rlc-step-plot), output C. */
export const STEP_PLOT_SETS: SeriesSet[] = [SET.U1, SET.OVS]

/** Readouts (rlc-readouts). */
export const READOUT_SETS: SeriesSet[] = [SET.READ_A, SET.CR, SET.BA_HF, SET.U1]

/** Tolerances. Each is derived in the rationale of its check (checks.ts). */
export const TOL = {
  METRICS_REL: 1e-9,
  RESPONSE_ABS: 1e-6,
  STEP_ABS: 1e-6,
  PEAK_DB: 1e-3,
  PEAK_PCT: 1e-3,
  BODE_F_SPREAD: 0.012,
  BODE_DB: 0.5,
  BODE_EDGE_FRAC: 0.01,
  AUTORANGE_PX: 0.75,
  DECADE_VERTICAL_PX: 0.5,
  DECADE_POS_PX: 1,
  DECADE_F_REL: 1e-9,
  LOG_INTEGER: 1e-9,
  TEN_MULTIPLE: 1e-9,
  PEAK_RESOLVED_DB: 0.5,
  STEP_TMAX_REL: 0.01,
  STEP_EDGE_FRAC: 0.005,
  STEP_END_FRAC: 0.98,
  STEP_T_FRAC: 0.004,
  STEP_V_FRAC: 0.01,
  /** The step tolerance may use at most this many times the true span of the response. */
  STEP_SPAN_FACTOR: 3,
  STEP_PX: 0.75,
  READOUT_REL: 1e-3,
  MIN_VERTICES: 200,
  /** Largest horizontal gap between neighbouring vertices (plot edges included), as a share of the width. */
  GAP_FRAC: 0.05,
  /** A drawn plot narrower or shorter than this on screen cannot show a curve. */
  MIN_AREA_PX: 40,
  /** A decade gridline must cover at least this share of the gain plot's height to belong to it. */
  DECADE_OVERLAP_FRAC: 0.5,
} as const
