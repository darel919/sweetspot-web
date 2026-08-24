import { DurableObject } from 'cloudflare:workers'
import {
  MAX_PAYLOAD_BYTES,
  KNOWN_TYPES,
  SESSION_ONLY_TYPES,
  isEnvelope,
  isDeviceTargeted,
  isValidPairCode,
  isRoomSocketPingMessage,
  validatePayload,
  type Envelope,
  type ErrorPayload,
} from '../shared/types/protocol'

const DEVICE_TTL_MS = 15_000
// Only the HTTP fallback uses this TTL. WebSocket presence is derived from
// the live attached socket and needs no application heartbeat.
const CLIENT_TTL_MS = 30_000
const MAX_QUEUE = 32
const RATE_WINDOW_MS = 10_000
const RATE_MAX = 60

interface Waiter {
  resolve: (v: string) => void
  timer: ReturnType<typeof setTimeout>
}

interface ConnState {
  stamps: number[]
}

interface SocketAttachment {
  role: 'client' | 'device'
  connectionId: string
}

export class RoomDO extends DurableObject<unknown> {
  state: DurableObjectState
  deviceSeenAt = 0
  clientSeenAt = 0
  commands: Envelope[] = []
  forClients: Array<{ env: Envelope; at: number }> = []
  waiters = new Set<Waiter>()
  connStates = new Map<string, ConnState>()

  constructor(state: DurableObjectState, env: unknown) {
    super(state, env)
    this.state = state
  }

  rateLimited(key: string): boolean {
    const now = Date.now()
    let cs = this.connStates.get(key)
    if (!cs) {
      cs = { stamps: [] }
      this.connStates.set(key, cs)
    }
    cs.stamps = cs.stamps.filter((t) => now - t < RATE_WINDOW_MS)
    cs.stamps.push(now)
    return cs.stamps.length > RATE_MAX
  }

  validate(env: unknown): { ok: true; env: Envelope } | { ok: false; code: ErrorPayload['code']; message: string } {
    if (!isEnvelope(env)) {
      return { ok: false, code: 'bad_envelope', message: 'envelope requires v=1, id and type strings' }
    }
    if (!KNOWN_TYPES.has(env.type)) {
      return { ok: false, code: 'unknown_type', message: `unsupported message type "${env.type}"` }
    }
    if (SESSION_ONLY_TYPES.has(env.type)) {
      return { ok: false, code: 'bad_envelope', message: `"${env.type}" is session-scoped and not routed` }
    }
    const payloadError = validatePayload(env.type, env.payload)
    if (payloadError) return { ok: false, code: 'bad_envelope', message: payloadError }
    return { ok: true, env }
  }

  deviceOnline(): boolean {
    return this.hasOpenSocket('device') || Date.now() - this.deviceSeenAt < DEVICE_TTL_MS
  }

  clientOnline(): boolean {
    return this.hasOpenSocket('client') || Date.now() - this.clientSeenAt < CLIENT_TTL_MS
  }

  private hasOpenSocket(role: SocketAttachment['role']): boolean {
    return this.ctx.getWebSockets().some((ws) => {
      const attachment = this.socketAttachment(ws)
      return attachment?.role === role && ws.readyState === WebSocket.OPEN
    })
  }

  wake() {
    for (const w of this.waiters) {
      clearTimeout(w.timer)
      w.resolve('')
    }
    this.waiters.clear()
  }

  private async restorePresence() {
    const seenAt = await this.state.storage.get<number>('deviceSeenAt')
    if (typeof seenAt === 'number' && Number.isFinite(seenAt)) this.deviceSeenAt = seenAt
  }

  private async markDeviceSeen() {
    const wasOnline = this.deviceOnline()
    this.deviceSeenAt = Date.now()
    await this.state.storage.put('deviceSeenAt', this.deviceSeenAt)
    await this.state.storage.setAlarm(this.deviceSeenAt + DEVICE_TTL_MS)
    if (!wasOnline) this.broadcastPresence(true)
  }

  private socketAttachment(ws: WebSocket): SocketAttachment | null {
    const attachment = ws.deserializeAttachment()
    if (typeof attachment !== 'object' || attachment === null) return null
    if (
      (attachment.role !== 'client' && attachment.role !== 'device')
      || typeof attachment.connectionId !== 'string'
    ) return null
    return attachment as SocketAttachment
  }

  private sendSocket(ws: WebSocket, value: unknown): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(value))
      return true
    } catch {
      try { ws.close(1011, 'room send failed') } catch {}
      return false
    }
  }

  private broadcastPresence(deviceOnline: boolean) {
    const value = { kind: 'room.presence', deviceOnline }
    for (const ws of this.ctx.getWebSockets()) {
      if (this.socketAttachment(ws)?.role === 'client') this.sendSocket(ws, value)
    }
  }

  private broadcastClientPresence(clientOnline: boolean) {
    const value = { kind: 'room.clientPresence', clientOnline }
    for (const ws of this.ctx.getWebSockets()) {
      if (this.socketAttachment(ws)?.role === 'device') this.sendSocket(ws, value)
    }
  }

  private broadcastEnvelope(env: Envelope) {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.socketAttachment(ws)?.role === 'client') this.sendSocket(ws, env)
    }
  }

  private queueCommand(env: Envelope) {
    const device = this.ctx.getWebSockets().find((ws) => {
      const attachment = this.socketAttachment(ws)
      return attachment?.role === 'device' && ws.readyState === WebSocket.OPEN
    })
    if (device && this.sendSocket(device, env)) return

    this.commands.push(env)
    if (this.commands.length > MAX_QUEUE) this.commands.splice(0, this.commands.length - MAX_QUEUE)
    this.wake()
  }

  private queueClientReplay(env: Envelope) {
    if (env.type === 'state.snapshot') return
    this.forClients.push({ env, at: Date.now() })
    if (this.forClients.length > MAX_QUEUE) this.forClients.splice(0, this.forClients.length - MAX_QUEUE)
  }

  private socketError(ws: WebSocket, code: ErrorPayload['code'] | 'bad_json' | 'bad_message', message: string) {
    this.sendSocket(ws, { kind: 'room.error', code, message })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attachment = this.socketAttachment(ws)
    if (!attachment) {
      try { ws.close(1008, 'invalid room socket') } catch {}
      return
    }
    if (this.rateLimited(attachment.connectionId)) {
      this.socketError(ws, 'rate_limited', 'Too many messages')
      return
    }
    const body = typeof message === 'string' ? message : new TextDecoder().decode(message)
    if (body.length > MAX_PAYLOAD_BYTES) {
      this.socketError(ws, 'payload_too_large', 'Message exceeds the room payload limit')
      return
    }
    let value: unknown
    try {
      value = JSON.parse(body)
    } catch {
      this.socketError(ws, 'bad_json', 'Message was not valid JSON')
      return
    }
    if (isRoomSocketPingMessage(value)) {
      if (attachment.role !== 'client') {
        this.socketError(ws, 'bad_message', 'Only clients may send room.ping')
        return
      }
      this.clientSeenAt = Date.now()
      this.sendSocket(ws, { kind: 'room.presence', deviceOnline: this.deviceOnline() })
      return
    }
    const validated = this.validate(value)
    if (validated.ok === false) {
      this.socketError(ws, validated.code, validated.message)
      return
    }
    if (attachment.role === 'client') {
      if (!isDeviceTargeted(validated.env.type)) {
        this.socketError(ws, 'unknown_type', 'Clients may only send device-targeted types')
        return
      }
      this.clientSeenAt = Date.now()
      this.queueCommand(validated.env)
      return
    }

    this.queueClientReplay(validated.env)
    this.broadcastEnvelope(validated.env)
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string) {
    const attachment = this.socketAttachment(ws)
    if (!attachment) return

    this.connStates.delete(attachment.connectionId)
    if (attachment.role === 'device' && !this.hasOpenSocket('device')) {
      this.deviceSeenAt = 0
      await this.state.storage.delete('deviceSeenAt')
      await this.state.storage.deleteAlarm()
      this.broadcastPresence(false)
    }
    if (attachment.role === 'client' && !this.hasOpenSocket('client')) {
      this.clientSeenAt = 0
      this.broadcastClientPresence(false)
    }
  }

  webSocketError(_ws: WebSocket, error: unknown) {
    console.warn('SweetSpot room WebSocket error', error)
  }

  async alarm() {
    await this.restorePresence()
    if (this.deviceSeenAt <= 0) return
    if (this.hasOpenSocket('device')) return
    if (this.deviceOnline()) {
      await this.state.storage.setAlarm(this.deviceSeenAt + DEVICE_TTL_MS)
      return
    }
    this.broadcastPresence(false)
  }

  private async openSocket(request: Request, role: SocketAttachment['role']): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }

    if (role === 'device') {
      for (const ws of this.ctx.getWebSockets()) {
        if (this.socketAttachment(ws)?.role === 'device' && ws.readyState === WebSocket.OPEN) {
          try { ws.close(1000, 'replaced by newer device connection') } catch {}
        }
      }
      this.deviceSeenAt = 0
      await this.state.storage.delete('deviceSeenAt')
      await this.state.storage.deleteAlarm()
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ role, connectionId: crypto.randomUUID() } satisfies SocketAttachment)
    if (role === 'client') this.clientSeenAt = Date.now()
    await this.restorePresence()
    this.sendSocket(server, {
      kind: 'room.ready',
      role,
      deviceOnline: this.deviceOnline(),
      messages: role === 'device' ? this.commands.splice(0, this.commands.length) : this.forClients.map(({ env }) => env),
    })
    if (role === 'device') {
      this.broadcastPresence(true)
      this.sendSocket(server, { kind: 'room.clientPresence', clientOnline: this.clientOnline() })
    } else {
      this.broadcastClientPresence(true)
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === '/ws' && request.method === 'GET') {
      const role = url.searchParams.get('role')
      if (role !== 'client' && role !== 'device') {
        return new Response('Invalid room socket role', { status: 400 })
      }
      return this.openSocket(request, role)
    }

    if (path === '/register' && request.method === 'POST') {
      await this.restorePresence()
      await this.markDeviceSeen()
      return Response.json({ ok: true })
    }

    if (path === '/commands' && request.method === 'GET') {
      await this.restorePresence()
      await this.markDeviceSeen()
      const waitS = Math.min(parseFloat(url.searchParams.get('wait') ?? '9') || 9, 25)
      const clientOnline = () => this.clientOnline()
      if (this.commands.length > 0) {
        const out = this.commands
        this.commands = []
        return Response.json({ commands: out, clientOnline: clientOnline() })
      }
      if (waitS <= 0) return Response.json({ commands: [], clientOnline: clientOnline() })
      const result = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          this.waiters.delete(w)
          resolve('')
        }, waitS * 1000)
        const w: Waiter = { resolve, timer }
        this.waiters.add(w)
      })
      if (result) return Response.json({ ...(JSON.parse(result) as { commands: Envelope[] }), clientOnline: clientOnline() })
      return Response.json({ commands: this.commands.splice(0, this.commands.length), clientOnline: clientOnline() })
    }

    if (path === '/device' && request.method === 'POST') {
      const body = await request.text()
      if (body.length > MAX_PAYLOAD_BYTES) {
        return Response.json({ error: 'payload_too_large' }, { status: 413 })
      }
      let env: unknown
      try {
        env = JSON.parse(body)
      } catch {
        return Response.json({ error: 'bad_json' }, { status: 400 })
      }
      const v = this.validate(env)
      if (v.ok === false) return Response.json({ error: v.code, message: v.message }, { status: 400 })
      await this.restorePresence()
      await this.markDeviceSeen()
      this.queueClientReplay(v.env)
      this.broadcastEnvelope(v.env)
      return Response.json({ ok: true })
    }

    if (path === '/client' && request.method === 'POST') {
      const body = await request.text()
      if (body.length > MAX_PAYLOAD_BYTES) {
        return Response.json({ error: 'payload_too_large' }, { status: 413 })
      }
      let env: unknown
      try {
        env = JSON.parse(body)
      } catch {
        return Response.json({ error: 'bad_json' }, { status: 400 })
      }
      const v = this.validate(env)
      if (v.ok === false) return Response.json({ error: v.code, message: v.message }, { status: 400 })
      if (!isDeviceTargeted(v.env.type)) {
        return Response.json({ error: 'unknown_type', message: `clients may only send device-targeted types` }, { status: 400 })
      }
      this.clientSeenAt = Date.now()
      this.queueCommand(v.env)
      return Response.json({ ok: true })
    }

    if (path === '/state' && request.method === 'GET') {
      await this.restorePresence()
      this.clientSeenAt = Date.now()
      const since = parseInt(url.searchParams.get('since') ?? '0') || 0
      const messages = this.forClients.filter((m) => m.at > since).map((m) => m.env)
      return Response.json({ deviceOnline: this.deviceOnline(), clientOnline: this.clientOnline(), messages })
    }

    return new Response('not found', { status: 404 })
  }
}
