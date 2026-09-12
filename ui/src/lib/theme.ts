// Theme override: 'system' follows the OS via light-dark(); 'light'/'dark'
// pin `data-theme` on <html>, which flips `color-scheme` (see app.css).
// app.html applies the persisted value pre-paint; this module is the
// runtime switcher for the top-bar control.

export type Theme = 'system' | 'light' | 'dark';

const KEY = 'token-horizon.theme';

export function getTheme(): Theme {
	if (typeof localStorage === 'undefined') return 'system';
	const t = localStorage.getItem(KEY);
	return t === 'light' || t === 'dark' ? t : 'system';
}

export function applyTheme(t: Theme) {
	if (typeof document === 'undefined') return;
	if (t === 'system') delete document.documentElement.dataset.theme;
	else document.documentElement.dataset.theme = t;
}

export function setTheme(t: Theme) {
	if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, t);
	applyTheme(t);
}
