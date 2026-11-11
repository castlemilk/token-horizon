import { describe, expect, it } from 'vitest'
import * as R from './reference'
import { CONTRACT, DIAGNOSTICS, ENERGY, HUD, KEPLER, SOFTENING, SYMPLECTIC } from './hidden'

const yoshida = (b: R.Body[], G: number, eps: number, dt: number) => R.yoshida4(b, G, eps, dt)

/** Largest relative energy error sampled every `stride` steps over `count` samples. */
function energyErrors(
  stepper: (b: R.Body[], dt: number) => void,
  bodies: R.Body[],
  dt: number,
  stride: number,
  count: number
): number {
  const b = R.copyBodies(bodies)
  const e0 = R.energy(b, 1, 0)
  let worst = 0
  for (let k = 0; k < count; k++) {
    for (let s = 0; s < stride; s++) stepper(b, dt)
    worst = Math.max(worst, R.relativeEnergyError(e0, R.energy(b, 1, 0)))
  }
  return worst
}

describe('orbit-lab reference: constructions', () => {
  it('two-body ellipse starts at periapsis with zero centre-of-mass motion', () => {
    const G = 1.3
    const b = R.twoBody(G, 1.5, 2.5, 2.2, 0.6, 0.4)
    const sep = [b[1].x - b[0].x, b[1].y - b[0].y]
    expect(Math.hypot(sep[0], sep[1])).toBeCloseTo(2.2 * (1 - 0.6), 12)
    const [px, py] = R.momentum(b)
    expect(Math.abs(px) + Math.abs(py)).toBeLessThan(1e-12)
    const [cx, cy] = R.centreOfMass(b)
    expect(Math.abs(cx) + Math.abs(cy)).toBeLessThan(1e-12)
  })

  it('vis-viva: the periapsis speed matches the orbit energy', () => {
    const G = 0.7
    const a = 1.9
    const e = 0.4
    const b = R.twoBody(G, 1, 1, a, e, 0)
    const rel = Math.hypot(b[1].vx - b[0].vx, b[1].vy - b[0].vy)
    const vp = Math.sqrt((G * 2 * (1 + e)) / (a * (1 - e)))
    expect(rel).toBeCloseTo(vp, 12)
  })

  it('figure-eight has zero momentum and centre of mass, and period 6.32591398 for lambda 1', () => {
    const fig = R.figureEight(1, 1, 1)
    const [px, py] = R.momentum(fig.bodies)
    const [cx, cy] = R.centreOfMass(fig.bodies)
    // The published velocities are rounded to 8 digits, so the net momentum is 1e-8, not 0.
    expect(Math.hypot(px, py)).toBeLessThan(2e-8)
    expect(Math.hypot(cx, cy)).toBeLessThan(2e-8)
    expect(fig.T).toBeCloseTo(6.32591398, 8)
    expect(R.period(1, 3, 1)).toBeCloseTo(2 * Math.PI / Math.sqrt(3), 12)
  })

  it('the figure-eight energy scales as expected: E0 of lambda 3.2, mass 0.8 is negative and finite', () => {
    const f = R.figureEight(ENERGY.fig8.lambda, ENERGY.fig8.m, ENERGY.fig8.G)
    const e0 = R.energy(f.bodies, 1, 0)
    expect(Number.isFinite(e0)).toBe(true)
    expect(e0).toBeLessThan(0)
  })
})

describe('orbit-lab reference: the integrators the thresholds were measured with', () => {
  it('Yoshida-4 meets the energy requirement for runs A and B; Verlet fails it', () => {
    for (const run of [ENERGY.runA, ENERGY.runB]) {
      const bodies = R.twoBody(1, ENERGY.mass, ENERGY.mass, run.a, ENERGY.e, run.rot)
      const T = R.period(1, 2 * ENERGY.mass, run.a)
      const fine = energyErrors(
        (b, dt) => yoshida(b, 1, 0, dt),
        bodies,
        T / ENERGY.finePerPeriod,
        ENERGY.fineStride,
        (ENERGY.periods * ENERGY.finePerPeriod) / ENERGY.fineStride
      )
      const coarse = energyErrors(
        (b, dt) => yoshida(b, 1, 0, dt),
        bodies,
        T / ENERGY.coarsePerPeriod,
        ENERGY.coarseStride,
        (ENERGY.periods * ENERGY.coarsePerPeriod) / ENERGY.coarseStride
      )
      expect(fine).toBeLessThan(ENERGY.bound)
      expect(fine < ENERGY.waiver || coarse / fine >= ENERGY.ratioMin).toBe(true)
      const verletFine = energyErrors(
        (b, dt) => R.verlet(b, 1, 0, dt),
        bodies,
        T / ENERGY.finePerPeriod,
        ENERGY.fineStride,
        (ENERGY.periods * ENERGY.finePerPeriod) / ENERGY.fineStride
      )
      expect(verletFine).toBeGreaterThan(ENERGY.bound)
    }
  })

  it('Yoshida-4 keeps the scaled figure-eight within 1e-7 at 1000 steps per period', () => {
    const f = R.figureEight(ENERGY.fig8.lambda, ENERGY.fig8.m, ENERGY.fig8.G)
    const worst = energyErrors(
      (b, dt) => yoshida(b, 1, 0, dt),
      f.bodies,
      f.T / ENERGY.fig8.stepsPerPeriod,
      ENERGY.fig8.stride,
      ENERGY.fig8.steps / ENERGY.fig8.stride
    )
    expect(worst).toBeLessThan(ENERGY.fig8.bound)
    expect(worst).toBeGreaterThan(1e-10)
  })

  it('Yoshida-4 conserves Lz to rounding at 100 steps per period; RK4 does not', () => {
    for (const run of [SYMPLECTIC.runA, SYMPLECTIC.runB]) {
      const bodies = R.twoBody(1, run.m1, run.m2, run.a, SYMPLECTIC.e, run.rot)
      const dt = R.period(1, run.m1 + run.m2, run.a) / SYMPLECTIC.stepsPerPeriod
      const b = R.copyBodies(bodies)
      const L0 = R.angularMomentum(b)
      let worst = 0
      for (let k = 0; k < SYMPLECTIC.periods; k++) {
        for (let s = 0; s < SYMPLECTIC.stepsPerPeriod; s++) yoshida(b, 1, 0, dt)
        worst = Math.max(worst, Math.abs((R.angularMomentum(b) - L0) / L0))
      }
      expect(worst).toBeLessThan(SYMPLECTIC.lzBound)
      const r = R.copyBodies(bodies)
      for (let s = 0; s < SYMPLECTIC.reverseSteps; s++) yoshida(r, 1, 0, dt)
      for (const p of r) {
        p.vx = -p.vx
        p.vy = -p.vy
      }
      for (let s = 0; s < SYMPLECTIC.reverseSteps; s++) yoshida(r, 1, 0, dt)
      const D = run.a * (1 - SYMPLECTIC.e)
      const reversal = Math.max(...r.map((p, i) => Math.hypot(p.x - bodies[i].x, p.y - bodies[i].y))) / D
      expect(reversal).toBeLessThan(SYMPLECTIC.reverseBound)
    }
    const run = SYMPLECTIC.runA
    const bodies = R.twoBody(1, run.m1, run.m2, run.a, SYMPLECTIC.e, run.rot)
    const dt = R.period(1, run.m1 + run.m2, run.a) / SYMPLECTIC.stepsPerPeriod
    const b = R.copyBodies(bodies)
    const L0 = R.angularMomentum(b)
    for (let s = 0; s < 1000; s++) R.rk4(b, 1, 0, dt)
    expect(Math.abs((R.angularMomentum(b) - L0) / L0)).toBeGreaterThan(1e-5)
  })

  it('Yoshida-4 satisfies the Kepler apoapsis and period relations', () => {
    const K = KEPLER
    const b = R.twoBody(K.G, K.m1, K.m2, K.a, K.e, K.rot, K.boost as [number, number])
    const T = R.period(K.G, K.m1 + K.m2, K.a)
    const dt = T / K.stepsPerPeriod
    const s0 = [b[1].x - b[0].x, b[1].y - b[0].y]
    for (let k = 0; k < K.half; k++) yoshida(b, K.G, 0, dt)
    const sH = [b[1].x - b[0].x, b[1].y - b[0].y]
    for (let k = 0; k < K.half; k++) yoshida(b, K.G, 0, dt)
    const sT = [b[1].x - b[0].x, b[1].y - b[0].y]
    const q = (1 + K.e) / (1 - K.e)
    expect(Math.hypot(sH[0] + q * s0[0], sH[1] + q * s0[1]) / K.a).toBeLessThan(K.posTol)
    expect(Math.hypot(sT[0] - s0[0], sT[1] - s0[1]) / K.a).toBeLessThan(K.posTol)
  })
})

describe('orbit-lab reference: softening and diagnostics', () => {
  it('RK4 at 48000 steps agrees with 96000 steps far inside the 2e-3 bound', () => {
    const bodies = SOFTENING.bodies as R.Body[]
    const a = R.rk4Reference(bodies, SOFTENING.G, SOFTENING.softening, 6, SOFTENING.refSteps)
    const b = R.rk4Reference(bodies, SOFTENING.G, SOFTENING.softening, 6, SOFTENING.refSteps * 2)
    const worst = Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)))
    expect(worst).toBeLessThan(1e-9)
  })

  it('Yoshida-4 with the right softening is inside the bound; ignoring softening is outside it', () => {
    const bodies = SOFTENING.bodies as R.Body[]
    const ref = R.rk4Reference(bodies, SOFTENING.G, SOFTENING.softening, 6, SOFTENING.refSteps)
    const right = R.copyBodies(bodies)
    const wrong = R.copyBodies(bodies)
    for (let k = 0; k < SOFTENING.steps; k++) {
      yoshida(right, SOFTENING.G, SOFTENING.softening, SOFTENING.dt)
      yoshida(wrong, SOFTENING.G, 0, SOFTENING.dt)
    }
    const err = (x: R.Body[]) => Math.max(...x.map((p, i) => Math.hypot(p.x - ref[i].x, p.y - ref[i].y)))
    expect(err(right)).toBeLessThan(SOFTENING.bound)
    expect(err(wrong)).toBeGreaterThan(1)
  })

  it('the softened potential is finite and uses the eps^2 form', () => {
    const b: R.Body[] = [
      { m: 1, x: 0, y: 0, vx: 0, vy: 0 },
      { m: 1, x: 3, y: 4, vx: 0, vy: 0 },
    ]
    expect(R.potential(b, 1, 0)).toBeCloseTo(-1 / 5, 12)
    expect(R.potential(b, 1, 1)).toBeCloseTo(-1 / Math.sqrt(26), 12)
  })

  it('every diagnostics component of both configurations is well away from zero', () => {
    for (const cfg of DIAGNOSTICS.configs) {
      const bodies = cfg.bodies.map((p) => ({ ...p }))
      for (const step of [0, DIAGNOSTICS.steps]) {
        if (step > 0) for (let k = 0; k < step; k++) yoshida(bodies, cfg.G, cfg.softening, cfg.dt)
        const d = R.diagnosticsOf(bodies, cfg.G, cfg.softening)
        const scales: Array<[string, number, number]> = [
          ['kinetic', d.kinetic, d.kinetic],
          ['potential', d.potential, Math.abs(d.potential)],
          ['energy', d.energy, Math.abs(d.kinetic) + Math.abs(d.potential)],
          ['angularMomentum', d.angularMomentum, bodies.reduce((s, p) => s + p.m * Math.hypot(p.x, p.y) * Math.hypot(p.vx, p.vy), 0)],
          ['momentum x', d.momentum[0], bodies.reduce((s, p) => s + p.m * Math.abs(p.vx), 0)],
          ['momentum y', d.momentum[1], bodies.reduce((s, p) => s + p.m * Math.abs(p.vy), 0)],
          ['com x', d.com[0], bodies.reduce((s, p) => s + p.m * Math.abs(p.x), 0) / R.totalMass(bodies)],
          ['com y', d.com[1], bodies.reduce((s, p) => s + p.m * Math.abs(p.y), 0) / R.totalMass(bodies)],
        ]
        for (const [name, value, scale] of scales) {
          expect(Math.abs(value), `${name} at step ${step}`).toBeGreaterThan(0.01 * scale)
        }
      }
    }
  })
})

describe('orbit-lab reference: the HUD expectation and the contract system', () => {
  it('the HUD bodies at G 1.9 after 7 steps give E about -5.75 and Lz about 0.706', () => {
    const b = R.copyBodies(HUD.bodies as R.Body[])
    for (let k = 0; k < HUD.steps; k++) yoshida(b, HUD.opts.G, 0, HUD.opts.dt)
    expect(R.energy(b, HUD.opts.G, 0)).toBeCloseTo(-5.7518, 3)
    expect(R.angularMomentum(b)).toBeCloseTo(0.70625, 4)
    expect(HUD.steps * HUD.opts.dt).toBeCloseTo(HUD.time, 12)
  })

  it('the contract bodies are the ones named in the notes (three bodies, unit-free masses)', () => {
    expect(CONTRACT.bodies.length).toBe(3)
    expect(CONTRACT.timeAfterFiveSteps).toBeCloseTo(CONTRACT.stepsA * CONTRACT.opts.dt, 12)
  })
})
