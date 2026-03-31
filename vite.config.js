import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/ExpenseBAC/',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      workbox: {
        // Never let the Service Worker intercept external API calls.
        // This is the fix for iOS PWA "Load failed" on googleapis.com.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.hostname.includes('googleapis.com') || url.hostname.includes('google.com'),
            handler: 'NetworkOnly',
          }
        ]
      },
      manifest: {
        name: 'ExpenseBAC',
        short_name: 'ExpenseBAC',
        description: 'Read your BAC expenses easily',
        theme_color: '#ef4444',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [
          {
            src: '/favicon.svg',
            sizes: '192x192',
            type: 'image/svg+xml'
          },
          {
            src: '/favicon.svg',
            sizes: '512x512',
            type: 'image/svg+xml'
          }
        ]
      }
    })
  ]
})
