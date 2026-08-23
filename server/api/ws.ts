import { defineEventHandler, createError } from 'h3'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  MAX_PAYLOAD_BYTES,
  KNOWN_TYPES,
  SESSION_ONLY_TYPES,
  isDeviceTargeted,
  isValidPairCode,
  pairRoom,
  type Envelope,
  type ErrorPayload,
  type Role,
} from '../../shared/types/protocol'

const RATE_LIMIT_WINDOW_MS = 10_000
const RATE_LIMIT_MAX_MESSAGES = 60

interface Room {
  device?: WebSocket
  clients: Set<WebSocket>
}

interface ConnContext {
  role: Role
  room: string
  helloDone: boolean
  stamps: number[]
}

const rooms = new Map<string, Room>()
const contexts = new WeakMap<WebSocket, ConnContext>()

let relayCounter = 0

function relayId(): string {
  return `relay_${Date.now().toString(36)}_${(relayCounter++).toString(36)}`
}

function sendError(ws: WebSocket, code: ErrorPayload['code'], message?: string) {
  ws.send(JSON.stringify({
    v: 1,
    id: relayId(),
    type: 'session.error',
    ts: Date.now(),
    payload: { code, message },
  }))
}

function welcomePayload(room: string, r: Room) {
  return {
    room,
    peers: { deviceOnline: !!r.device, clients: r.clients.size },
  }
}

function broadcastPeerEvent(room: Room, from: WebSocket, type: 'session.peerJoined' | 'session.peerLeft') {
  const data = JSON.stringify({
    v: 1,
    id: relayId(),
    type,
    ts: Date.now(),
    payload: { role: contexts.get(from)?.role ?? 'client' },
  })
  for (const client of room.clients) {
    if (client !== from && client.readyState === WebSocket.OPEN) client.send(data)
  }
  if (room.device && room.device !== from && room.device.readyState === WebSocket.OPEN) {
    room.device.send(data)
  }
}

function dropConn(ws: WebSocket) {
  const ctx = contexts.get(ws)
  if (!ctx) return
  const room = rooms.get(ctx.room)
  if (room) {
    if (ctx.role === 'device') {
      if (room.device === ws) room.device = undefined
    } else {
      room.clients.delete(ws)
    }
    if (!room.device && room.clients.size === 0) rooms.delete(ctx.room)
    broadcastPeerEvent(room, ws, 'session.peerLeft')
  }
  contexts.delete(ws)
}

function rateLimited(ctx: ConnContext): boolean {
  const now = Date.now()
  while (ctx.stamps.length && now - ctx.stamps[0] > RATE_LIMIT_WINDOW_MS) ctx.stamps.shift()
  ctx.stamps.push(now)
  return ctx.stamps.length > RATE_LIMIT_MAX_MESSAGES
}

function handleMessage(ws: WebSocket, text: string) {
  const ctx = contexts.get(ws)
  if (!ctx) return

  if (rateLimited(ctx)) {
    sendError(ws, 'rate_limited', 'too many messages')
    ws.close()
    return
  }

  if (text.length > MAX_PAYLOAD_BYTES) {
    sendError(ws, 'payload_too_large')
    ws.close()
    return
  }

  let env: Partial<Envelope>
  try {
    env = JSON.parse(text)
  } catch {
    sendError(ws, 'bad_envelope', 'message is not valid JSON')
    return
  }

  if (env.v !== 1 || typeof env.id !== 'string' || typeof env.type !== 'string') {
    sendError(ws, 'bad_envelope', 'envelope requires v=1, id and type strings')
    return
  }

  if (env.type === 'ping' || env.type === 'pong') {
    if (env.type === 'ping') ws.send(JSON.stringify({ ...env, type: 'pong', ts: Date.now() }))
    return
  }

  if (!KNOWN_TYPES.has(env.type)) {
    sendError(ws, 'unknown_type', `unsupported message type "${env.type}"`)
    return
  }

  if (!ctx.helloDone) {
    if (env.type !== 'session.hello') {
      sendError(ws, 'bad_envelope', 'first message must be session.hello')
      ws.close()
      return
    }
    const payload = env.payload as { role?: Role; room?: string } | undefined
    const role = payload?.role
    const roomName = payload?.room
    if ((role !== 'device' && role !== 'client') || typeof roomName !== 'string' || !isValidPairCode(roomName)) {
      sendError(ws, 'bad_envelope', 'session.hello requires role device|client and a valid pair-code room')
      ws.close()
      return
    }
    const roomKey = pairRoom(roomName)
    const room = rooms.get(roomKey) ?? (() => {
      const r = { clients: new Set<WebSocket>() }
      rooms.set(roomKey, r)
      return r
    })()

    ctx.role = role
    ctx.room = roomKey

    if (role === 'device') {
      if (room.device) {
        sendError(ws, 'bad_envelope', 'another device already owns this room')
        ws.close()
        return
      }
      room.device = ws
    } else {
      room.clients.add(ws)
    }

    ctx.helloDone = true
    ws.send(JSON.stringify({
      v: 1,
      id: relayId(),
      type: 'session.welcome',
      ts: Date.now(),
      payload: welcomePayload(roomKey, room),
    }))
    broadcastPeerEvent(room, ws, 'session.peerJoined')
    return
  }

  if (SESSION_ONLY_TYPES.has(env.type)) {
    sendError(ws, 'bad_envelope', `"${env.type}" is only allowed once after connect`)
    return
  }

  if (isDeviceTargeted(env.type)) {
    if (ctx.role !== 'client') {
      sendError(ws, 'bad_envelope', `only clients may send "${env.type}"`)
      return
    }
    const room = rooms.get(ctx.room)
    if (!room?.device || room.device.readyState !== WebSocket.OPEN) {
      sendError(ws, 'not_in_room', 'no device online in this room')
      return
    }
    room.device.send(text)
    return
  }

  const room = rooms.get(ctx.room)
  if (!room) {
    sendError(ws, 'not_in_room', 'peer is not in a room')
    return
  }
  if (ctx.role === 'device') {
    for (const client of room.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(text)
    }
  } else if (room.device && room.device.readyState === WebSocket.OPEN) {
    room.device.send(text)
  }
}

const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: () => false,
})

wss.on('connection', (ws) => {
  contexts.set(ws, { role: 'client', room: '', helloDone: false, stamps: [] })
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      sendError(ws, 'bad_envelope', 'binary frames are not accepted')
      ws.close()
      return
    }
    handleMessage(ws, data.toString())
  })
  ws.on('close', () => dropConn(ws))
  ws.on('error', () => dropConn(ws))
})

/**
 * Manual WebSocket upgrade endpoint.
 *
 * Works on Vercel Functions (raw socket comes from the @vercel/request-context
 * upgrade primitive) and on plain Node (raw socket comes straight off the h3
 * event). Nitro's own experimental websocket support is intentionally NOT used;
 * its Vercel preset gained upgrade support only in Nitro v3.
 */
export default defineEventHandler((event) => {
  const req = event.node.req
  const ctxStore = (globalThis as Record<symbol, unknown>)[Symbol.for('@vercel/request-context')] as
    | { get?: () => { upgradeWebSocket?: () => { req: import('node:http').IncomingMessage; socket: import('node:stream').Duplex; head: Buffer } | null } }
    | undefined
  const ctx = typeof ctxStore?.get === 'function' ? ctxStore.get() : null

  if (typeof ctx?.upgradeWebSocket !== 'function') {
    throw createError({
      statusCode: 501,
      statusMessage: 'WebSocket upgrade not supported by this runtime',
    })
  }

  const upgrade = ctx.upgradeWebSocket()
  if (!upgrade?.req || !upgrade?.socket) {
    throw createError({ statusCode: 502, statusMessage: 'Upgrade primitive returned no socket' })
  }

  wss.handleUpgrade(upgrade.req, upgrade.socket, upgrade.head, (ws) => wss.emit('connection', ws, upgrade.req))
  return new Promise<void>(() => {})
})
