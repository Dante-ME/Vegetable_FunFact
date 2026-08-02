import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'RootFacts - AI Plant/Root Recognition',
        short_name: 'RootFacts',
        description: 'Aplikasi AI untuk mengenali tanaman dan akar serta memberikan fakta menarik',
        lang: 'id',
        theme_color: '#10b981',
        background_color: '#f9fafb',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: 'icons/icon-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      },
      workbox: {
        // Precache the app shell plus the local vision-classifier's static
        // files (json/bin, ~2.2MB total) so detection keeps working offline
        // after the first visit. The text-generation model is intentionally
        // NOT listed here - it's fetched from Hugging Face at runtime, and
        // Transformers.js already caches it itself via the Cache Storage
        // API, so a Workbox rule here would just duplicate that.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json,bin}'],
        // The self-hosted text model lives in public/models/. Its .onnx
        // weights are already excluded by globPatterns (no .onnx entry),
        // but its config/tokenizer JSONs would otherwise be swept into the
        // precache manifest - duplicating files transformers.js already
        // caches itself via the Cache Storage API, and forcing the whole
        // ~2MB tokenizer.json to download before the app shell is usable.
        globIgnores: ['models/**'],
        // Workbox's default 2 MiB cap is smaller than both weights.bin
        // (~2.16MB) and this app's main JS chunk (~2.3MB) - raised with
        // headroom so precaching doesn't start failing the build again
        // after a routine dependency bump.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  server: {
    port: 3001,
    host: true
  }
});
