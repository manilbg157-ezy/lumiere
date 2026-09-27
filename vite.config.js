import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import authPlugin from './server/auth-plugin.js'

export default defineConfig({
  plugins: [react(), authPlugin()],
  server: {
    allowedHosts: ['seasnail-clever-solely.ngrok-free.app'],
    proxy: {
      // TMDB metadata + posters, proxied so browsers on networks that block
      // TMDB (or lack CORS-friendly access) still load titles and images.
      '/tmdbapi': {
        target: 'https://api.themoviedb.org',
        changeOrigin: true,
        rewrite: p => p.replace(/^\/tmdbapi/, ''),
      },
      '/tmdbimg': {
        target: 'https://image.tmdb.org',
        changeOrigin: true,
        rewrite: p => p.replace(/^\/tmdbimg/, ''),
      },
      // Local stream backends — avoids CORS and works from any device
      // that can reach this dev server (LAN/Tailscale included).
      '/tmbea': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        rewrite: p => p.replace(/^\/tmbea/, ''),
      },
      '/cinepro': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: p => p.replace(/^\/cinepro/, ''),
      },
    },
  },
})
