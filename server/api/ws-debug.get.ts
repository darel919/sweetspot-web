export default defineEventHandler((event) => {
  const req = event.node.req
  const ctxStore = (globalThis as Record<symbol, unknown>)[Symbol.for('@vercel/request-context')] as
    | { get?: () => Record<string, unknown> }
    | undefined
  const ctx = typeof ctxStore?.get === 'function' ? ctxStore.get() : null
  return {
    upgradeHeader: req.headers.upgrade ?? null,
    connectionHeader: req.headers.connection ?? null,
    hasUpgradeCtx: typeof (ctx as { upgradeWebSocket?: unknown })?.upgradeWebSocket === 'function',
    ctxKeys: ctx ? Object.keys(ctx) : [],
    httpVersion: req.httpVersion,
    socketRemote: (req.socket as { remoteAddress?: string } | undefined)?.remoteAddress ?? null,
  }
})
