// DiceBear vendor entry: deterministic generated avatars for handles without
// a profile photo. Bundled by scripts/build-vendor.mjs into
// docs/vendor/dicebear.js (window.DiceBear).
import { createAvatar } from '@dicebear/core';
import {
  identicon,
  thumbs,
  shapes,
  initials,
  botttsNeutral,
  funEmoji,
  rings
} from '@dicebear/collection';

const STYLES = {
  identicon,
  thumbs,
  shapes,
  initials,
  bottts: botttsNeutral,
  emoji: funEmoji,
  rings
};

/// Deterministic SVG for (style, seed). Style/seed are stable per handle, so
/// avatars never shuffle between renders.
function avatarSvg(style, seed, options = {}) {
  const collection = STYLES[style] || identicon;
  const size = options.size || 96;
  return createAvatar(collection, {
    seed: String(seed || 'anonymous'),
    size,
    radius: options.radius == null ? 50 : options.radius,
    backgroundColor: options.backgroundColor || ['0F141E', '141B28', '1A2233', '232C3D', '101826']
  }).toString();
}

const DiceBear = { avatarSvg, styles: Object.keys(STYLES) };

if (typeof window !== 'undefined') {
  window.DiceBear = DiceBear;
}

export default DiceBear;
