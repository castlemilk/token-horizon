import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../docs/theme.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../docs/theme.css', import.meta.url), 'utf8');

// Exercise browser preference and storage boundaries without launching Chrome or
// touching real accounts. The fixture only supplies APIs used by the controller.
function environment({ saved = null, dark = false, storageBlocked = false, ready = 'complete', bootstrapTheme } = {}) {
  const listeners = new Map(), changes = [], storage = new Map();
  if (saved !== null) storage.set('th-theme', saved);
  const root = { dataset: {}, style: {} };
  if (bootstrapTheme) root.dataset.theme = bootstrapTheme;
  const slots = [];
  const media = { matches: dark, addEventListener(name, handler) { if (name === 'change') this.change = handler; } };
  function slot() {
    const item = { children: [], querySelector() { return this.children.find(child => child.className === 'th-theme-toggle'); }, append(child) { this.children.push(child); } };
    slots.push(item);
    return item;
  }
  function createElement() {
    return { dataset: {}, attributes: {}, handlers: {}, setAttribute(key, value) { this.attributes[key] = value; }, addEventListener(name, handler) { this.handlers[name] = handler; } };
  }
  const document = {
    documentElement: root,
    readyState: ready,
    querySelectorAll(selector) { return selector === '[data-theme-control]' ? slots : slots.flatMap(item => item.children); },
    createElement,
    addEventListener(name, handler) { listeners.set('document:' + name, handler); }
  };
  const localStorage = {
    getItem(key) { if (storageBlocked) throw new Error('Storage is blocked'); return storage.get(key) ?? null; },
    setItem(key, value) { if (storageBlocked) throw new Error('Storage is blocked'); storage.set(key, value); },
    removeItem(key) { if (storageBlocked) throw new Error('Storage is blocked'); storage.delete(key); }
  };
  const window = {
    addEventListener(name, handler) { listeners.set('window:' + name, handler); },
    dispatchEvent(event) { changes.push(event); }
  };
  const context = vm.createContext({ document, window, localStorage, matchMedia: () => media, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
  const control = slot();
  vm.runInContext(source, context);
  return { root, media, storage, slots, control, window, changes, api: window.TokenHorizonTheme, slot,
    button: () => control.children[0],
    domReady() { document.readyState = 'complete'; listeners.get('document:DOMContentLoaded')?.(); },
    system(next) { media.matches = next; media.change?.(); },
    external(value, key = 'th-theme') { listeners.get('window:storage')?.({ key, newValue: value }); },
    runAgain() { vm.runInContext(source, context); }
  };
}

test('system preference is applied before DOM readiness and controls mount once', () => {
  const app = environment({ dark: true, ready: 'loading' });
  assert.equal(app.root.dataset.theme, 'dark');
  assert.equal(app.root.style.colorScheme, 'dark');
  assert.equal(app.button(), undefined);
  app.domReady();
  assert.equal(app.button().attributes['aria-label'], 'Switch to light mode');
  assert.equal(app.button().attributes['aria-pressed'], 'true');
  app.runAgain();
  assert.equal(app.control.children.length, 1);
});

test('remembered selection wins over OS preference and the prepaint bootstrap agrees', () => {
  const app = environment({ saved: 'light', dark: true, bootstrapTheme: 'light' });
  assert.equal(app.api.get().theme, 'light');
  assert.equal(app.api.get().preference, 'light');
  assert.equal(app.changes.length, 0);
  app.system(false);
  app.system(true);
  assert.equal(app.root.dataset.theme, 'light');
});

test('a real button toggles, persists and synchronizes every mounted control', () => {
  const app = environment();
  const second = app.slot();
  app.api.mount();
  app.button().handlers.click();
  assert.equal(app.root.dataset.theme, 'dark');
  assert.equal(app.storage.get('th-theme'), 'dark');
  assert.equal(app.button().attributes['aria-label'], 'Switch to light mode');
  assert.equal(second.children[0].attributes['aria-pressed'], 'true');
  assert.equal(app.changes.length, 1);
  assert.equal(app.changes[0].type, 'th:themechange');
  assert.equal(app.changes[0].detail.theme, 'dark');
  app.button().handlers.click();
  assert.equal(app.storage.get('th-theme'), 'light');
});

test('invalid storage is ignored and OS changes apply until the user chooses', () => {
  const app = environment({ saved: 'null' });
  assert.equal(app.api.get().preference, 'system');
  app.system(true);
  assert.equal(app.root.dataset.theme, 'dark');
  app.button().handlers.click();
  app.system(false);
  app.system(true);
  assert.equal(app.root.dataset.theme, 'light');
});

test('storage failures never disable the toggle or overwrite its in-page selection', () => {
  const app = environment({ storageBlocked: true });
  app.button().handlers.click();
  assert.equal(app.root.dataset.theme, 'dark');
  app.system(false);
  assert.equal(app.root.dataset.theme, 'dark');
  app.api.set('system');
  assert.equal(app.root.dataset.theme, 'light');
  assert.equal(app.api.get().preference, 'system');
});

test('other tabs synchronize the theme; clearing storage resumes the OS default', () => {
  const app = environment({ dark: true, saved: 'dark' });
  app.external('light');
  assert.equal(app.root.dataset.theme, 'light');
  assert.equal(app.button().attributes['aria-pressed'], 'false');
  app.external('dark', 'unrelated-key');
  assert.equal(app.root.dataset.theme, 'light');
  app.external(null);
  assert.equal(app.root.dataset.theme, 'dark');
  app.system(false);
  assert.equal(app.root.dataset.theme, 'light');
});

test('invalid programmatic input cannot corrupt the mode or persistence', () => {
  const app = environment({ saved: 'light' });
  app.api.set('sepia');
  assert.equal(app.root.dataset.theme, 'light');
  assert.equal(app.storage.get('th-theme'), 'light');
});

function luminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
}
const contrast = (one, two) => { const a = luminance(one), b = luminance(two); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };

test('both semantic palettes keep body, secondary labels and actions at AA contrast', () => {
  for (const theme of ['light', 'dark']) {
    const block = css.match(new RegExp('html\\[data-theme="' + theme + '"\\] \\{([\\s\\S]*?)\\}'))?.[1];
    assert.ok(block, theme + ' palette exists');
    const colors = Object.fromEntries([...block.matchAll(/(--th-[\w-]+):\s*(#[a-f\d]{6});/gi)].map(([, key, value]) => [key, value]));
    for (const background of ['--th-bg', '--th-surface', '--th-surface-2']) {
      for (const text of ['--th-text', '--th-muted', '--th-faint', '--th-accent']) {
        assert.ok(contrast(colors[text], colors[background]) >= 4.5, `${theme} ${text} on ${background} needs AA contrast`);
      }
    }
    assert.ok(contrast(colors['--th-accent'], colors['--th-accent-ink']) >= 4.5, theme + ' primary control text');
  }
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'Authored motion respects reduced motion');
  assert.ok(css.includes('@media (forced-colors: active)'), 'Toggle remains usable with forced system colors');
  assert.ok(!/filter\s*:\s*invert\b/i.test(css), 'Provider, league and OG assets never get global inversion');
});
