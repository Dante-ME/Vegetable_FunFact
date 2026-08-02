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
        // after the first visit. The text-generation model can't be
        // precached - it's fetched from Hugging Face at runtime, not built
        // into dist/ - so it's handled by runtimeCaching below instead.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json,bin}'],
        // Workbox's default 2 MiB cap is smaller than both weights.bin
        // (~2.16MB) and this app's main JS chunk (~2.3MB) - raised with
        // headroom so precaching doesn't start failing the build again
        // after a routine dependency bump.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [
          {
            // Text-generation model weights/tokenizer/config, fetched from
            // the Hugging Face Hub by Transformers.js at runtime.
            //
            // Transformers.js does keep its own Cache Storage copy, but that
            // cache is written by the page, not by the Service Worker, so
            // nothing serves these requests when the SW is the only thing
            // running (offline / SW-controlled navigations). This rule puts
            // them under Service Worker control, which is what makes the
            // generation feature genuinely available offline after the
            // first successful load.
            //
            // CacheFirst is the right strategy here: these files are
            // immutable per revision and tens of MB, so once cached there is
            // no reason to ever hit the network for them again.
            urlPattern: /^https:\/\/huggingface\.co\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'transformers-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60 * 24 * 30,
              },
              // 0 keeps opaque responses (the Hub 302-redirects weight
              // downloads to its CDN) cacheable instead of silently dropped.
              cacheableResponse: {
                statuses: [0, 200],
              },
              rangeRequests: true,
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 3001,
    host: true
  }
});
