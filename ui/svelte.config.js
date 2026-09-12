import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) =>
			!filename.split(/[/\\]/).includes('node_modules')
	},
	kit: {
		// SPA mode: the whole UI is a static bundle (Tauri webview / any static
		// host) talking to the Token Horizon loopback API.
		adapter: adapter({ fallback: 'index.html' })
	}
};

export default config;
