import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// NOTE: passing options to sveltekit() here makes kit ignore svelte.config.js
// entirely — keep all config in svelte.config.js.
export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	// Tauri dev expects a fixed port.
	server: { port: 5173, strictPort: true },
	build: { target: 'es2022' }
});
