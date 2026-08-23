// Decisive test: does ctx.upgradeWebSocket() exist when a REAL ws upgrade hits /api/ws?
// The ws-debug route above proved headers are stripped on normal GETs, but Vercel docs say
// upgrade requests are routed with the raw socket available via the request context.
// This route answers ONLY via that primitive, no header checks.
import { defineEventHandler, createError } from 'h3'
import { WebSocketServer } from 'ws'

const g = globalThis as Record<string, unknown>
g.__dbgWss ??= new WebSocketServer({ noServer: true })
const wss = g.__dbgWss as InstanceType<typeof WebSocketServer>
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ v: 1, id: 'dbg', type: 'pong', ts: Date.now(), payload: {} }))
})

export default defineEventHandler(() => {
  const store = (globalThis as unknown as Record<symbol, { get?: () => Record<string, unknown> }>)[Symbol.for('@vercel/request-context')]
  const ctx = typeof store?.get === 'function' ? store.get() : null
  const up = ctx?.upgradeWebSocket
  if (typeof up !== 'function') {
    throw createError({ statusCode: 501, statusMessage: 'no upgradeWebSocket on context' })
  }
  const { req, socket, head } = up()
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  return new Promise<void>(() => {})
})
