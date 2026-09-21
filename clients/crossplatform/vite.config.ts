import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Browser-first build of the Swift-app port. `npm run build` emits a static
// bundle to dist/ servable by any static host; the dashboard talks to the
// local daemons on 127.0.0.1 directly (CORS is open on :8765/:8766/:11435).
export default defineConfig({
  root: 'app',
  base: './',
  plugins: [tailwindcss(), react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
})
