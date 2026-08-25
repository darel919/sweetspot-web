// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  ssr: false,
  vite: {
    define: {
      'import.meta.env.NUXT_PUBLIC_BUILD_SHA': JSON.stringify(process.env.NUXT_PUBLIC_BUILD_SHA ?? 'local'),
    },
  },
  app: {
    head: {
      meta: [
        { name: 'robots', content: 'noindex, nofollow' },
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
