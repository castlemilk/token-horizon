// Shared visual language with the dashboard sign-in: precomputed lensed light map.
export function createBlackHole(opts = {}) {
  const W = opts.width || 72, H = opts.height || 32;
  const TAU = Math.PI * 2;
  const RS = 1;                                    // event horizon radius
  const CAM_Y = opts.camY ?? 1.05, CAM_Z = opts.camZ ?? 13;
  const WORLD_HALF = opts.worldHalf ?? 7.6;        // horizontal half-extent
  const DX = (WORLD_HALF * 2) / W;
  const DY = DX * (opts.aspect ?? 1.66);           // monospace cell aspect
  const MAXSTEP = opts.maxStep || 200;
  const RAMP = opts.ramp || " .:-=+*#%@";
  const FRAME_MS = opts.frameMs || 33;             // ~30fps cap
  const STARS = opts.stars !== false;              // background star field
  const TURB_BASE = opts.turbBase ?? 0.86;         // disk turbulence
  const TURB_AMP = opts.turbAmp ?? 0.18;
  const TOK_GAIN = opts.tokGain ?? 1.55;           // token stream brightness
  const TOK_VAR = opts.tokSigma2 ?? 0.018;         // token stream width

  const light = new Array(W * H);
  let built = false, el = null, raf = 0, pending = 0, lastNow = 0, time = 4.2, running = false;

  const fract = v => v - Math.floor(v);
  const smoothstep = (a, b, x) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const reduceMotion = () => {
    try { return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch (_) { return false; }
  };

  /// Trace every screen cell once. Stores, per cell, the disk-plane
  /// crossings (radius + angle of each lensed image) and a background star.
  function buildLightMap() {
    const started = performance.now();
    const dl = Math.hypot(CAM_Y, CAM_Z);
    const vy0 = -CAM_Y / dl, vz0 = -CAM_Z / dl;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        let px = (i + 0.5 - W / 2) * DX;
        let py = (H / 2 - 0.5 - j) * DY + CAM_Y;
        let pz = CAM_Z;
        let vx = 0, vy = vy0, vz = vz0;
        let cx = py * vz - pz * vy, cy = -px * vz, cz = px * vy;
        const h2 = cx * cx + cy * cy + cz * cz;
        const crossings = [];
        let bg = 0;
        for (let s = 0; s < MAXSTEP; s++) {
          const r2 = px * px + py * py + pz * pz;
          const r = Math.sqrt(r2);
          if (r < RS) break;                                // swallowed
          if (s > 0 && r > 16 && (px * vx + py * vy + pz * vz) > 0) {
            if (STARS) {
              const sn = fract(Math.sin(Math.round(vx * 57) * 12.9898 + Math.round(vy * 57) * 78.233) * 43758.5453);
              if (sn > 0.986) bg = 0.22 + (sn - 0.986) * 16;
            }
            break;
          }
          const dt = Math.min(0.5, Math.max(0.07, r * 0.09));
          const ir5 = 1 / (r2 * r2 * r);
          const ax = -1.5 * h2 * px * ir5, ay = -1.5 * h2 * py * ir5, az = -1.5 * h2 * pz * ir5;
          const nx = px + vx * dt + 0.5 * ax * dt * dt;
          const ny = py + vy * dt + 0.5 * ay * dt * dt;
          const nz = pz + vz * dt + 0.5 * az * dt * dt;
          const nr2 = nx * nx + ny * ny + nz * nz;
          const nir5 = 1 / (nr2 * nr2 * Math.sqrt(nr2));
          vx += 0.5 * (ax - 1.5 * h2 * nx * nir5) * dt;
          vy += 0.5 * (ay - 1.5 * h2 * ny * nir5) * dt;
          vz += 0.5 * (az - 1.5 * h2 * nz * nir5) * dt;
          const vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
          vx /= vl; vy /= vl; vz /= vl;
          if (py * ny < 0) {                                // crossed the disk plane
            const f = py / (py - ny);
            const qx = px + (nx - px) * f, qz = pz + (nz - pz) * f;
            const rc = Math.sqrt(qx * qx + qz * qz);
            if (rc > 1.55 && rc < 6.2) crossings.push(rc, Math.atan2(qz, qx));
          }
          px = nx; py = ny; pz = nz;
        }
        light[j * W + i] = { c: crossings, bg };
      }
    }
    built = true;
    if (W >= 40) window.__bhBuildMs = Math.round(performance.now() - started);
  }

  /// Accretion-disk emission at a lensed crossing: radial profile,
  /// turbulence, doppler beaming, plus the inbound token streams.
  function disk(rc, ang, t) {
    const u = ang / TAU + 0.5;
    let d = smoothstep(2.0, 2.6, rc) * (1 - smoothstep(4.55, 5.5, rc));
    if (d <= 0) return [0, 0];
    d *= 0.55 + 1.3 * Math.exp(-((rc - 2.35) * (rc - 2.35)) / 2.6);
    d *= TURB_BASE + TURB_AMP * Math.sin(u * TAU * 6 + rc * 1.9 - t * 1.4);
    d *= 0.72 + 0.42 * Math.cos(ang - 0.7);
    const p = fract(u * 8 + rc * 1.05 - t * 0.6);
    const tok = TOK_GAIN * Math.exp(-((p - 0.5) * (p - 0.5)) / TOK_VAR);
    return [d + tok, tok];
  }

  function draw() {
    if (!el) return;
    let out = "";
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const cell = light[j * W + i];
        let b = cell.bg, tok = false;
        for (let k = 0; k < cell.c.length; k += 2) {
          const [d, tk] = disk(cell.c[k], cell.c[k + 1], time);
          if (d > b) { b = d; tok = tk > 0.5; }
        }
        const idx = Math.max(0, Math.min(RAMP.length - 1, Math.floor(b * (RAMP.length - 1) + [0, 0.5, 0.75, 0.25][(i % 2) + (j % 2) * 2])));
        const ch = RAMP[idx];
        out += tok && ch !== " " ? `<span class="bh-tok">${ch}</span>` : ch;
      }
      out += "\n";
    }
    el.innerHTML = out;
  }

  function frame(now) {
    if (!running) return;
    if (!el || !el.isConnected) { running = false; el = null; return; }
    raf = requestAnimationFrame(frame);
    if (now - lastNow < FRAME_MS) return;
    if (lastNow) time += Math.min(0.12, (now - lastNow) / 1000);
    lastNow = now;
    draw();
  }

  function run(animate) {
    if (!el) return;
    draw();
    if (!animate || reduceMotion()) return;
    running = true;
    lastNow = 0;
    raf = requestAnimationFrame(frame);
  }

  return {
    start(target, startOpts = {}) {
      this.stop();
      el = target;
      const go = () => {
        if (!el) return;
        if (!built) buildLightMap();
        run(startOpts.animate !== false);
      };
      if (built) return go();
      if (startOpts.defer === 0) return go();
      pending = setTimeout(() => { pending = 0; go(); }, startOpts.defer ?? 24);
    },
    resume() {
      if (!el || !built || running || reduceMotion()) return;
      running = true;
      lastNow = 0;
      raf = requestAnimationFrame(frame);
    },
    pause() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
    stop() {
      this.pause();
      if (pending) { clearTimeout(pending); pending = 0; }
      el = null;
    },
    get ready() { return built; }
  };
}
