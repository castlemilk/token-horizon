import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Plain-web build of the renderer (no Electron main/preload): `npm run build:web` emits a static
// bundle to out/web that can be served by any static host — the dashboard talks to the local
// daemons on 127.0.0.1 directly. Shell chrome degrades via `isElectron` guards (app/shell/).
const aliases = {
  '@/app': resolve(__dirname, 'app'),
  '@/lib': resolve(__dirname, 'lib'),
  '@/conveyor': resolve(__dirname, 'conveyor'),
  '@/resources': resolve(__dirname, 'resources'),
}

export default defineConfig({
  root: 'app',
  base: './',
  resolve: {
    alias: aliases,
    dedupe: ['react', 'react-dom', '@tanstack/react-query', 'zustand'],
  },
  plugins: [tailwindcss(), react()],
  build: {
    outDir: '../out/web',
    emptyOutDir: true,
  },
})
