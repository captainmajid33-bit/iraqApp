/**
 * vite.config.mobile.ts — Build config for Capacitor (Android / iOS)
 *
 * Differences from vite.config.ts:
 *   • No PORT / BASE_PATH env var requirements (not needed for native builds)
 *   • base: './'  — Capacitor loads assets from the local filesystem
 *   • No dev-server proxy (API calls go to production URL in native app)
 *   • No Replit-specific plugins (cartographer, dev-banner)
 *   • outDir matches capacitor.config.ts webDir → dist/public
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  base: './',
  appType: 'spa',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(import.meta.dirname, '..', '..', 'attached_assets'),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split large chunks so the app loads faster on mobile
        manualChunks: {
          'vendor-react':    ['react', 'react-dom'],
          'vendor-firebase': ['firebase/app', 'firebase/auth', 'firebase/firestore'],
          'vendor-leaflet':  ['leaflet'],
        },
      },
    },
  },
});
