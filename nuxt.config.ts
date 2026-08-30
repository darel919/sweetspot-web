// https://nuxt.com/docs/api/configuration/nuxt-config
const buildSha = process.env.NUXT_PUBLIC_BUILD_SHA ?? 'local'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  ssr: false,
  vite: {
    define: {
      'import.meta.env.NUXT_PUBLIC_BUILD_SHA': JSON.stringify(buildSha),
    },
  },
  app: {
    head: {
      meta: [
        { name: 'robots', content: 'noindex, nofollow' },
        { name: 'sweetspot-build-sha', content: buildSha },
      ],
    },
  },
  nitro: {
    preset: 'static',
    prerender: {
      routes: ['/api/calibration/profiles'],
    },
  },
})
