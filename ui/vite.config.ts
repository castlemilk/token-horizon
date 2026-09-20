import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// NOTE: passing options to sveltekit() here makes kit ignore svelte.config.js
// entirely — keep all config in svelte.config.js.
export default defineConfig({
	plugins: [
		{
			// Dev-only: the docs/ static site is symlinked into static/ (landing
			// assets, policy pages, blog/docs/models) so the landing and its
			// links resolve under the app origin. Vite's public middleware only
			// serves exact file paths, so resolve directory URLs to their
			// index.html here. Must run BEFORE the SvelteKit middleware (it 404s
			// unrouted directory URLs first). "/" itself is excluded — that is
			// the landing page, served by src/routes/+server.ts.
			name: 'th-site-index',
			configureServer(server) {
				server.middlewares.use((req: any, _res: any, next: () => void) => {
					const url: string = req.url ?? '';
					if (url !== '/' && url.endsWith('/')) {
						req.url = url + 'index.html';
					}
					next();
				});
			}
		},
		tailwindcss(),
		sveltekit()
	],
	// Tauri dev expects a fixed port. fs.allow reaches the repo root so the
	// (site) pages can read repo-level assets. Watch ignores keep Vite under
	// the inotify limit: src-tauri/target alone is tens of thousands of files
	// (Vite crashed with ENOSPC once the docs-site symlinks added more).
	server: {
		port: 5173,
		strictPort: true,
		fs: { allow: ['..'] },
		watch: {
			ignored: ['**/src-tauri/target/**', '**/static/docs/**', '**/static/blog/**', '**/static/models/**']
		}
	},
	build: { target: 'es2022' }
});
