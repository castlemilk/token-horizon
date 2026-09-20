// Resolve Playwright's chromium launcher in a CI-portable way: prefer the
// repo's devDependency (npm ci in CI), fall back to the original local
// checkout path used before Playwright was vendored as a dev dependency.
export async function resolveChromium() {
  try {
    const mod = await import("playwright");
    return mod.chromium;
  } catch (_) {
    const mod = await import("/Users/benebsworth/projects/tautau/web/node_modules/playwright/index.mjs");
    return mod.chromium;
  }
}
