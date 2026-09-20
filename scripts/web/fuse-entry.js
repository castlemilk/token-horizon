// Vendor entry: exposes Fuse.js on `window.Fuse` for the static Token Horizon
// dashboard's model explorer search. Bundled by scripts/build-vendor.mjs into
// docs/vendor/fuse.js so the page stays dependency-free at runtime and the
// explorer degrades to substring matching if the bundle is missing.
import Fuse from 'fuse.js';

if (typeof window !== 'undefined') {
  window.Fuse = Fuse;
}

export default Fuse;
