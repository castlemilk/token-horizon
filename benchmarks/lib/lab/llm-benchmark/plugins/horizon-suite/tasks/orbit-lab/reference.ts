/**
 * Independent Node reference for orbit-lab. Pure functions only: no DOM, no clock,
 * no window. Ported from the chief designer's orbit.cjs, orbit2.cjs, orbit3.cjs and
 * kepler_extra.cjs, which measured every threshold in the specification.
 *
 * Checks compare the page with these numbers. The page's own diagnostics() is never
 * used as an expectation, except where a check says so explicitly.
 */

export interface Body {
  m: number
  x: number
  y: number
  vx: number
  vy: number
}

export type Vec2 = [number, number]

export function copyBodies(bodies: readonly Body[]): Body[] {
  return bodies.map((b) => ({ m: b.m, x: b.x, y: b.y, vx: b.vx, vy: b.vy }))
}

// ---------------------------------------------------------------------------
// Forces and conserved quantities
// ---------------------------------------------------------------------------

/** Pairwise accelerations with Plummer softening: sum G m_j (r_j - r_i) / (|r_j - r_i|^2 + eps^2)^(3/2). */
export function accelerations(bodies: readonly Body[], G: number, eps: number): Vec2[] {
  const acc: Vec2[] = bodies.map(() => [0, 0])
  const e2 = eps * eps
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const dx = bodies[j].x - bodies[i].x
      const dy = bodies[j].y - bodies[i].y
      const r2 = dx * dx + dy * dy + e2
      const inv = G / (r2 * Math.sqrt(r2))
      acc[i][0] += bodies[j].m * dx * inv
      acc[i][1] += bodies[j].m * dy * inv
      acc[j][0] -= bodies[i].m * dx * inv
      acc[j][1] -= bodies[i].m * dy * inv
    }
  }
  return acc
}

export function kinetic(bodies: readonly Body[]): number {
  let k = 0
  for (const b of bodies) k += 0.5 * b.m * (b.vx * b.vx + b.vy * b.vy)
  return k
}

/** U = - sum over pairs i<j of G m_i m_j / sqrt(|r_j - r_i|^2 + eps^2). */
export function potential(bodies: readonly Body[], G: number, eps: number): number {
  let u = 0
  const e2 = eps * eps
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const dx = bodies[j].x - bodies[i].x
      const dy = bodies[j].y - bodies[i].y
      u -= (G * bodies[i].m * bodies[j].m) / Math.sqrt(dx * dx + dy * dy + e2)
    }
  }
  return u
}

export function energy(bodies: readonly Body[], G: number, eps: number): number {
  return kinetic(bodies) + potential(bodies, G, eps)
}

/** Angular momentum about the origin: sum m (x vy - y vx). */
export function angularMomentum(bodies: readonly Body[]): number {
  let l = 0
  for (const b of bodies) l += b.m * (b.x * b.vy - b.y * b.vx)
  return l
}

export function momentum(bodies: readonly Body[]): Vec2 {
  let px = 0
  let py = 0
  for (const b of bodies) {
    px += b.m * b.vx
    py += b.m * b.vy
  }
  return [px, py]
}

export function totalMass(bodies: readonly Body[]): number {
  return bodies.reduce((s, b) => s + b.m, 0)
}

/** Centre of mass: sum m r / sum m. */
export function centreOfMass(bodies: readonly Body[]): Vec2 {
  const M = totalMass(bodies)
  let cx = 0
  let cy = 0
  for (const b of bodies) {
    cx += b.m * b.x
    cy += b.m * b.y
  }
  return [cx / M, cy / M]
}

export interface Diagnostics {
  kinetic: number
  potential: number
  energy: number
  angularMomentum: number
  momentum: Vec2
  com: Vec2
}

/** The eight numbers orbit-diagnostics compares, recomputed from a state. */
export function diagnosticsOf(bodies: readonly Body[], G: number, eps: number): Diagnostics {
  const k = kinetic(bodies)
  const u = potential(bodies, G, eps)
  return {
    kinetic: k,
    potential: u,
    energy: k + u,
    angularMomentum: angularMomentum(bodies),
    momentum: momentum(bodies),
    com: centreOfMass(bodies),
  }
}

/** Largest |E - E0| / |E0| between two energy samples, relative to the first. */
export function relativeEnergyError(e0: number, e: number): number {
  return Math.abs((e - e0) / e0)
}

// ---------------------------------------------------------------------------
// Integrators (mutate the array), used by the reference tests and the RK4 reference
// ---------------------------------------------------------------------------

export function kick(bodies: Body[], G: number, eps: number, h: number): void {
  const a = accelerations(bodies, G, eps)
  bodies.forEach((b, i) => {
    b.vx += a[i][0] * h
    b.vy += a[i][1] * h
  })
}

export function drift(bodies: Body[], h: number): void {
  for (const b of bodies) {
    b.x += b.vx * h
    b.y += b.vy * h
  }
}

/** Velocity Verlet (kick-drift-kick). Symmetric, second order. */
export function verlet(bodies: Body[], G: number, eps: number, dt: number): void {
  kick(bodies, G, eps, dt / 2)
  drift(bodies, dt)
  kick(bodies, G, eps, dt / 2)
}

/** Yoshida's triple-jump coefficients: a fourth-order symmetric composition of Verlet. */
export const YOSHIDA_W1 = 1 / (2 - Math.cbrt(2))
export const YOSHIDA_W0 = -Math.cbrt(2) * YOSHIDA_W1

export function yoshida4(bodies: Body[], G: number, eps: number, dt: number): void {
  verlet(bodies, G, eps, YOSHIDA_W1 * dt)
  verlet(bodies, G, eps, YOSHIDA_W0 * dt)
  verlet(bodies, G, eps, YOSHIDA_W1 * dt)
}

/** Classical fourth-order Runge-Kutta. Not symplectic: used as the independent softening reference. */
export function rk4(bodies: Body[], G: number, eps: number, dt: number): void {
  const slope = (s: readonly Body[]): number[][] => {
    const a = accelerations(s, G, eps)
    return s.map((b, i) => [b.vx, b.vy, a[i][0], a[i][1]])
  }
  const shifted = (s: readonly Body[], k: number[][], f: number): Body[] =>
    s.map((b, i) => ({
      m: b.m,
      x: b.x + k[i][0] * f,
      y: b.y + k[i][1] * f,
      vx: b.vx + k[i][2] * f,
      vy: b.vy + k[i][3] * f,
    }))
  const k1 = slope(bodies)
  const k2 = slope(shifted(bodies, k1, dt / 2))
  const k3 = slope(shifted(bodies, k2, dt / 2))
  const k4 = slope(shifted(bodies, k3, dt))
  bodies.forEach((b, i) => {
    b.x += (dt / 6) * (k1[i][0] + 2 * k2[i][0] + 2 * k3[i][0] + k4[i][0])
    b.y += (dt / 6) * (k1[i][1] + 2 * k2[i][1] + 2 * k3[i][1] + k4[i][1])
    b.vx += (dt / 6) * (k1[i][2] + 2 * k2[i][2] + 2 * k3[i][2] + k4[i][2])
    b.vy += (dt / 6) * (k1[i][3] + 2 * k2[i][3] + 2 * k3[i][3] + k4[i][3])
  })
}

/** Integrate `time` with `steps` RK4 steps from a copy of `bodies`. */
export function rk4Reference(bodies: readonly Body[], G: number, eps: number, time: number, steps: number): Body[] {
  const b = copyBodies(bodies)
  const dt = time / steps
  for (let k = 0; k < steps; k++) rk4(b, G, eps, dt)
  return b
}

// ---------------------------------------------------------------------------
// Orbit constructions
// ---------------------------------------------------------------------------

/** Kepler period: 2 pi sqrt(a^3 / (G M)). */
export function period(G: number, M: number, a: number): number {
  return 2 * Math.PI * Math.sqrt((a * a * a) / (G * M))
}

/**
 * Two bodies on an ellipse with semi-major axis a and eccentricity e, starting at
 * periapsis. The periapsis direction is `rot`. The pair is split so that the
 * centre of mass sits at `centre` with velocity `boost`.
 */
export function twoBody(
  G: number,
  m1: number,
  m2: number,
  a: number,
  e: number,
  rot: number,
  boost: readonly [number, number] = [0, 0],
  centre: readonly [number, number] = [0, 0]
): Body[] {
  const M = m1 + m2
  const rp = a * (1 - e)
  const vp = Math.sqrt((G * M * (1 + e)) / (a * (1 - e)))
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  const r = [rp * c, rp * s]
  const v = [-vp * s, vp * c]
  return [
    {
      m: m1,
      x: centre[0] - (m2 / M) * r[0],
      y: centre[1] - (m2 / M) * r[1],
      vx: boost[0] - (m2 / M) * v[0],
      vy: boost[1] - (m2 / M) * v[1],
    },
    {
      m: m2,
      x: centre[0] + (m1 / M) * r[0],
      y: centre[1] + (m1 / M) * r[1],
      vx: boost[0] + (m1 / M) * v[0],
      vy: boost[1] + (m1 / M) * v[1],
    },
  ]
}

const FIG8_POS: Vec2[] = [
  [0.97000436, -0.24308753],
  [-0.97000436, 0.24308753],
  [0, 0],
]
const FIG8_VEL: Vec2[] = [
  [0.46620369, 0.43236573],
  [0.46620369, 0.43236573],
  [-0.93240737, -0.86473146],
]

/** The Chenciner-Montgomery figure-eight scaled by lambda, with unit masses m. Period T. */
export function figureEight(lambda: number, m: number, G: number): { bodies: Body[]; T: number } {
  const s = Math.sqrt((G * m) / lambda)
  return {
    bodies: FIG8_POS.map((p, i) => ({
      m,
      x: p[0] * lambda,
      y: p[1] * lambda,
      vx: FIG8_VEL[i][0] * s,
      vy: FIG8_VEL[i][1] * s,
    })),
    T: 6.32591398 * Math.sqrt((lambda * lambda * lambda) / (G * m)),
  }
}

/** Largest distance between any two bodies at the start. */
export function largestPairDistance(bodies: readonly Body[]): number {
  let d = 0
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      d = Math.max(d, Math.hypot(bodies[j].x - bodies[i].x, bodies[j].y - bodies[i].y))
    }
  }
  return d
}

/** sum m |r| |v| about the origin: the scale of Lz used by the Lz tolerance. */
export function angularScale(bodies: readonly Body[]): number {
  return bodies.reduce((s, b) => s + b.m * Math.hypot(b.x, b.y) * Math.hypot(b.vx, b.vy), 0)
}
