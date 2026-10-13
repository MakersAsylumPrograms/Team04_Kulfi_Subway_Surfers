import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  // `npm run dev:phone` serves HTTPS on the local network with a self-signed
  // certificate, because phones only share location with secure pages.
  server: mode === 'phone' ? { host: true } : undefined,
  plugins: [
    mode === 'phone' && basicSsl(),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Jam',
        short_name: 'Jam',
        description: 'Stories about the places you pass on your commute.',
        theme_color: '#f4f3ef',
        background_color: '#fafaf9',
        display: 'standalone',
        orientation: 'portrait',
        icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,json}'],
        // Story audio is cached as it plays; a "download this line" step comes later.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/audio/'),
            handler: 'CacheFirst',
            options: { cacheName: 'story-audio', rangeRequests: true },
          },
        ],
      },
    }),
  ],
}))
