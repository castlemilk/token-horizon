/**
 * Gallery pose for orbit-lab: drive the artifact to the public showcase scenario
 * (an eccentric binary, e = 0.9, 300 rounds of step(100) plus render) through the
 * prompt's own contract. The binary starts at apoapsis, so the camera that load fits
 * covers the whole ellipse; started at periapsis the fit would frame a 0.1-unit pair. Every input here is public. No check reads this file, and
 * it uses no hidden constant.
 */
export const pose: string = String.raw`(arg) => {
  var B = window.__bench;
  var G = 1;
  var e = 0.9;
  var a = 1;
  var m = 1;
  var M = 2 * m;
  var ra = a * (1 + e);
  var va = Math.sqrt(G * M * (1 - e) / (a * (1 + e)));
  var T = 2 * Math.PI * Math.sqrt(a * a * a / (G * M));
  B.load([
    { m: m, x: 0.5 * ra, y: 0, vx: 0, vy: 0.5 * va },
    { m: m, x: -0.5 * ra, y: 0, vx: 0, vy: -0.5 * va }
  ], { G: G, dt: T / 1000 });
  for (var r = 0; r < 300; r++) {
    B.step(100);
    B.render();
  }
  return B.state().t;
}`
