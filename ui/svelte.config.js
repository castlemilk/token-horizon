import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// SPA mode: the whole UI is a static bundle (Tauri webview / any static
		// host) talking to the Token Horizon loopback API.
		adapter: adapter({ fallback: 'index.html' })
	}
};

export default config;
