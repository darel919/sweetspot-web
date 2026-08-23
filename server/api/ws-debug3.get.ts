// Decisive: call upgradeWebSocket() on a REAL ws upgrade request to /api/ws-debug3.
// No header checks, no type checks. If the primitive works, we get 101.
import { defineEventHandler, createError } from 'h3'
import { WebSocketServer } from 'ws'

const g = globalThis as Record<string, unknown>
g.__dbgWss3 ??= new WebSocketServer({ noServer: true })
const wss = g.__dbgWss3 as InstanceType<typeof WebSocketServer>
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ v: 1, id: 'dbg3', type: 'pong', ts: Date.now(), payload: {} }))
})

export default defineEventHandler((event) => {
  const store = (globalThis as unknown as Record<symbol, { get?: () => Record<string, unknown> }>)[Symbol.for('@vercel/request-context')]
  const ctx = typeof store?.get === 'function' ? store.get() : null
  if (!ctx || typeof ctx.upgradeWebSocket !== 'function') {
    throw createError({
      statusCode: 501,
      statusMessage: `ctx=${ctx ? Object.keys(ctx).join(',') : 'null'} upType=${typeof ctx?.upgradeWebSocket} method=${event.node.req.method}`,
    })
  }
  const { req, socket, head } = ctx.upgradeWebSocket() as {
    req: import('node:http').IncomingMessage
    socket: import('node:stream').Duplex
    head: Buffer
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  return new Promise<void>(() => {})
})
