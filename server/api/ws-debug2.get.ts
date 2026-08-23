export default defineEventHandler(() => {
  const store = (globalThis as unknown as Record<symbol, { get?: () => Record<string, unknown> }>)[Symbol.for('@vercel/request-context')]
  const ctx = typeof store?.get === 'function' ? store.get() : null
  const up = ctx?.upgradeWebSocket
  return {
    upType: typeof up,
    upIsNull: up === null,
    upIsUndefined: up === undefined,
    upStringified: String(up).slice(0, 200),
  }
})
