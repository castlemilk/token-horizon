import type { BenchmarkTask } from '../../../../types'

/**
 * orbit-lab: the task row. The prompt is the Horizon suite's final prompt, copied verbatim
 * from the specification (checked against the JSON file by checks.test.ts).
 */
export const PROMPT = `Build a single-file HTML page, "Orbit Lab": a 2D gravitational N-body simulator drawn on a canvas, with trails, a diagnostics HUD and transport controls. A grading script loads its own hidden systems through the JavaScript API below, advances them step by step, and compares your numbers and your drawn pixels with an independent calculation. Use every id and function name exactly as written.

PHYSICS
- Bodies are point masses in the plane with state (m, x, y, vx, vy). World +y points up.
- Acceleration of body i: a_i = sum over j != i of G*m_j*(r_j - r_i) / (|r_j - r_i|^2 + eps^2)^(3/2). eps is the softening length given to load; eps = 0 is exact Newtonian gravity. Never add a softening or a distance floor of your own.
- Kinetic energy K = sum of 0.5*m_i*|v_i|^2. Potential energy U = - sum over pairs i<j of G*m_i*m_j / sqrt(|r_j - r_i|^2 + eps^2). Energy E = K + U.
- Momentum P = sum of m_i*v_i. Centre of mass R = sum of m_i*r_i / sum of m_i. Angular momentum about the ORIGIN: Lz = sum of m_i*(x_i*vy_i - y_i*vx_i).
- The simulated state contains nothing else: no damping, no collisions or merging, no walls, no speed limits, no re-centring of positions or velocities. To keep the picture centred, move the camera, never the bodies.

INTEGRATOR (fixed step dt supplied by the caller). The grader measures the properties below on hidden two-body and three-body systems of any masses, size and orientation. One method must have all of them at once.
(a) Fourth-order accuracy or better. On a two-body orbit of eccentricity 0.5 at 1000 steps per period, |E(t) - E(0)| / |E(0)| stays below 2e-6 for 10 periods, and the same run at 500 steps per period has a largest error at least 10 times bigger (a fourth-order method gives 16; the ratio is waived once the error is below 1e-10). On the three-body figure-eight orbit at 1000 steps per period the error stays below 1e-7.
(b) Angular momentum conserved to rounding error at ANY step size. At only 100 steps per period on an orbit of eccentricity 0.6, |Lz(t) - Lz(0)| stays below 1e-11 * |Lz(0)| for 10 periods. For three bodies it stays below 1e-11 * sum(m_i*|r_i|*|v_i|) taken at t = 0.
(c) Time-reversible at ANY step size. In those same coarse runs, advancing N steps, negating every velocity and advancing N more steps returns every body to its starting position within 1e-10 * D, where D is the largest initial distance between two bodies.
(d) step(n) is pure computation: no drawing, no DOM access, a handful of force evaluations per step. 20,000 steps of a three-body system take well under one second.

API (define window.__bench synchronously while the page loads)
- __bench.load(bodies, opts): replace the whole system. bodies is an array of 2 to 8 objects {m, x, y, vx, vy}; opts is {G, dt, softening} (softening may be omitted and then means 0). Copy the numbers: the caller may mutate its array afterwards. Set t = 0, clear the trails, fit the camera (see VIEW), stop any demo playback, PAUSE the simulation and draw one frame. After load, nothing changes the state except __bench.step: not timers, not animation frames.
- __bench.step(n): advance exactly n steps of size dt (n is a non-negative integer; step(0) does nothing). t increases by n*dt. Same input gives the same output bit for bit: no randomness, no dependence on frame timing, and step(2) followed by step(3) equals step(5).
- __bench.state(): returns {t, bodies:[{m,x,y,vx,vy}, ...]} as full-precision numbers in the order given to load. Immediately after load it returns exactly the numbers that were passed in.
- __bench.diagnostics(): returns {kinetic, potential, energy, angularMomentum, momentum:[px,py], com:[x,y]} for the current state using the formulas above (eps included in the potential).
- __bench.render(): synchronously redraw the canvas and the HUD from the current state. Calling it twice in a row with no step in between produces identical pixels.
- __bench.project(x, y): returns [px, py], the unrounded position of world point (x, y) in the canvas's own pixel grid (0..canvas.width, 0..canvas.height, the coordinates getImageData uses) for the current camera.

VIEW
- Draw on <canvas id="scene"> with a 2D context (not WebGL). The canvas covers at least half of the browser window. Its background is one flat colour or fully transparent; any decoration (stars, gradients, grid) goes on a layer behind the canvas, not in it.
- The camera is a uniform scale plus a translation: equal pixels per unit on both axes, +x to the right, +y up, no rotation. __bench.load fits it to the initial positions: every body projects inside the canvas with a margin of at least 5% of the smaller canvas dimension on each side, and the bodies' bounding box spans at least 35% of the smaller canvas dimension along its longer side. This must work whether the system is 0.01 or 1000 units across and wherever it sits in the plane. The camera then stays fixed until the next load. Built-in presets may frame themselves however you like.
- Each body is a solid, flat-filled disc of radius 4 to 24 canvas pixels centred on its projected position, drawn on top of everything else. Body k (its index in the array given to load) is always drawn in the k-th colour of a fixed palette of at least 8 colours; every palette colour differs from the background and from every other palette colour by more than 60 in at least one RGB channel.
- Trails: each render() that follows a change of state appends every body's current position to that body's trail (keep at least the latest 300 points per body). Draw each trail as a line at least 2 canvas pixels wide through its points, in a colour that differs from the background by more than 60 in at least one RGB channel, with the latest 100 points at full strength. Redraw trails from the stored history on every render; never create them by leaving old frames on the canvas.
- HUD, as HTML elements: <span id="hud-time">, <span id="hud-energy">, <span id="hud-angmom">. The text content of each is ONLY a number that JavaScript Number() can parse, correct to at least 7 significant digits (for example -1.287142e+0), refreshed by render(). Also show <span id="hud-drift">, the relative energy drift (E - E0)/|E0| since load.

PAGE
- On page load, start the figure-eight three-body choreography playing automatically with trails: G = 1, three unit masses at (0.97000436, -0.24308753), (-0.97000436, 0.24308753), (0, 0) with velocities (0.46620369, 0.43236573), (0.46620369, 0.43236573), (-0.93240737, -0.86473146), dt = 0.001, several steps per animation frame.
- Provide buttons #play-pause and #reset (reload the current preset) and a preset selector with at least three systems (figure-eight, a star with two planets, an eccentric binary). Compact dark HUD; the scene should read well as a still image.`

export const task: BenchmarkTask = {
  id: 'orbit-lab',
  slug: 'orbit-lab',
  category: 'advanced-physics',
  title: 'Orbit Lab: conservation laws under instrumentation',
  blurb: 'A 2D N-body simulator whose integrator, conservation laws, camera, pixels and HUD are each measured against an independent computation.',
  prompt: PROMPT,
  runtimeHint: 'Browser, offline Canvas 2D; the grader drives window.__bench and reads canvas#scene pixels',
  iterationsDefault: 3,
  methodNotes: 'Behavioural score: 70% from 11 browser checks (100 points) plus a 30% structural share. The checks drive window.__bench with hidden systems, sample state() and diagnostics(), and compare them with an independent Node reference (Yoshida, RK4, closed forms). They also read canvas#scene pixels and the three HUD spans. They verify: the load/step contract and determinism; the period and apoapsis of a Kepler orbit; energy error at two step sizes and on a figure-eight; Lz conservation and time reversal at a coarse step; momentum and centre-of-mass motion; softening against a 48,000-step reference; diagnostics() formulas on two configurations; the HUD digits; the camera fit at three scales and offsets; bodies drawn as index-coloured discs; and trails redrawn from history. A dynamics guard runs in front of the energy, symplectic and momentum checks: the first stride of each sampled run must match an independent integration, so a page that computes no gravity fails them. A frozen page fails: each sampled run must advance t and move. The trails check judges only the trail points that are on the canvas, and it lays the test binary along the shorter canvas axis. A step() that is too slow for the probe budget (the energy probe allows about 4 s) makes the page unresponsive, which fails the energy check and the checks after it; the 1 s speed claim is not timed, because a timing probe would make a check depend on wall-clock speed. They do NOT verify: the Yoshida scheme itself (any integrator that meets the thresholds passes), the preset choreography, the play, pause and reset buttons, the preset selector, layout or visual quality, the palette limits, the 1 s speed claim, or the Chromium-only rendering details beyond the pixel samples. Known limit (suite review): a step() too slow for the four-second energy probe fails that probe and the checks after it; at the prompt\'s own speed ceiling the probe needs about half a second. A page with no gravity still scores about 44, from checks of the API, HUD, camera and drawing it really does.',
  demoComponentName: 'HorizonSuiteDemo',
  scorer: 'behavioral',
  checks: [
    'orbit-contract-paused',
    'orbit-kepler-period',
    'orbit-energy-fourth-order',
    'orbit-symplectic-reversible',
    'orbit-momentum-com',
    'orbit-softening-reference',
    'orbit-diagnostics',
    'orbit-hud-numbers',
    'orbit-view-fit',
    'orbit-bodies-drawn',
    'orbit-trails-history',
  ],
}
