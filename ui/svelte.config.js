import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// SPA mode: the whole UI is a static bundle (Tauri webview / any static
		// host) talking to the Token Horizon loopback API. The fallback is
		// 200.html so the prerendered root (the landing page) keeps index.html.
		adapter: adapter({ fallback: '200.html' }),
		prerender: {
			handleHttpError({ path, message }) {
				// Directory URLs of the static docs site (symlinked into static/).
				// The prerender crawler can't resolve directory indexes, but the
				// files are copied into the bundle and any static host serves them.
				if (path.endsWith('/')) return;
				throw new Error(message);
			}
		}
	}
};

export default config;
