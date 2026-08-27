import { DurableObject } from 'cloudflare:workers'
import {
  MAX_CALIBRATION_CAPTURE_FRAME_BYTES,
  MAX_PAYLOAD_BYTES,
  KNOWN_TYPES,
  SESSION_ONLY_TYPES,
  isClientToDevice,
  isDeviceToClient,
  isEnvelope,
  validatePayload,
  type Envelope,
  type ErrorPayload,
} from '../shared/types/protocol'
import { decodeCalibrationCaptureFrame } from '../shared/transport/calibrationCaptureFrame'

const RATE_WINDOW_MS = 10_000
const MESSAGE_RATE_MAX = 60
const CONNECTION_RATE_MAX = 10
const MAX_CLIENTS = 4
const PAIRING_TTL_MS = 10 * 60 * 1_000
const EXPIRY_KEY = 'room-expires-at'

interface SocketAttachment {
  role: 'client' | 'device'
  rateKey: string
  expiresAt: number
}

export class RoomDO extends DurableObject<unknown> {
  private readonly state: DurableObjectState

  constructor(state: DurableObjectState, env: unknown) {
    super(state, env)
    this.state = state
  }

  private async rateLimited(key: string, limit: number): Promise<boolean> {
    const now = Date.now()
    const storageKey = `rate:${key}`
    const stored = await this.state.storage.get<number[]>(storageKey)
    const stamps = (stored ?? []).filter((stamp) => now - stamp < RATE_WINDOW_MS)
    if (stamps.length >= limit) {
      await this.state.storage.put(storageKey, stamps)
      return true
    }
    stamps.push(now)
    await this.state.storage.put(storageKey, stamps)
    return false
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
    return this.hasOpenSocket('device')
  }

  clientOnline(): boolean {
    return this.hasOpenSocket('client')
  }

  private hasOpenSocket(role: SocketAttachment['role']): boolean {
    return this.state.getWebSockets().some((ws) => {
      const attachment = this.socketAttachment(ws)
      return attachment?.role === role && ws.readyState === WebSocket.OPEN
    })
  }

  private socketAttachment(ws: WebSocket): SocketAttachment | null {
    const attachment = ws.deserializeAttachment()
    if (typeof attachment !== 'object' || attachment === null) return null
    if (
      (attachment.role !== 'client' && attachment.role !== 'device')
      || typeof attachment.rateKey !== 'string'
      || typeof attachment.expiresAt !== 'number'
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
    for (const ws of this.state.getWebSockets()) {
      if (this.socketAttachment(ws)?.role === 'client') this.sendSocket(ws, value)
    }
  }

  private broadcastClientPresence(clientOnline: boolean) {
    const value = { kind: 'room.clientPresence', clientOnline }
    for (const ws of this.state.getWebSockets()) {
      if (this.socketAttachment(ws)?.role === 'device') this.sendSocket(ws, value)
    }
  }

  private broadcastEnvelope(env: Envelope) {
    if (env.expiresAt !== undefined && env.expiresAt <= Date.now()) return
    for (const ws of this.state.getWebSockets()) {
      if (this.socketAttachment(ws)?.role === 'client') this.sendSocket(ws, env)
    }
  }

  private sendCommandToDevice(env: Envelope): boolean {
    const device = this.state.getWebSockets().find((ws) => {
      const attachment = this.socketAttachment(ws)
      return attachment?.role === 'device' && ws.readyState === WebSocket.OPEN
    })
    return device ? this.sendSocket(device, env) : false
  }

  private sendBinaryCommandToDevice(data: ArrayBuffer): boolean {
    const device = this.state.getWebSockets().find((ws) => {
      const attachment = this.socketAttachment(ws)
      return attachment?.role === 'device' && ws.readyState === WebSocket.OPEN
    })
    if (!device || device.readyState !== WebSocket.OPEN) return false
    try {
      device.send(data)
      return true
    } catch {
      try { device.close(1011, 'room send failed') } catch {}
      return false
    }
  }

  private socketError(ws: WebSocket, code: ErrorPayload['code'] | 'bad_json' | 'bad_message', message: string) {
    this.sendSocket(ws, { kind: 'room.error', code, message })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attachment = this.socketAttachment(ws)
    if (!attachment || attachment.expiresAt <= Date.now()) {
      try { ws.close(1008, 'pairing session expired') } catch {}
      return
    }
    if (await this.rateLimited(`message:${attachment.rateKey}`, MESSAGE_RATE_MAX)) {
      this.socketError(ws, 'rate_limited', 'Too many messages')
      return
    }
    if (typeof message !== 'string') {
      if (attachment.role !== 'client') {
        this.socketError(ws, 'bad_message', 'The TV may only send JSON protocol envelopes')
        return
      }
      if (message.byteLength > MAX_CALIBRATION_CAPTURE_FRAME_BYTES) {
        this.socketError(ws, 'payload_too_large', 'Calibration capture exceeds the binary room limit')
        return
      }
      const frame = decodeCalibrationCaptureFrame(message)
      if (!frame.ok) {
        this.socketError(ws, 'bad_message', frame.message)
        return
      }
      if (!this.sendBinaryCommandToDevice(message)) {
        this.socketError(ws, 'not_in_room', 'The TV is not connected to this pairing session')
      }
      return
    }
    const body = message
    if (new TextEncoder().encode(body).byteLength > MAX_PAYLOAD_BYTES) {
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
    const validated = this.validate(value)
    if (validated.ok === false) {
      this.socketError(ws, validated.code, validated.message)
      return
    }
    if (attachment.role === 'client') {
      if (!isClientToDevice(validated.env.type)) {
        this.socketError(ws, 'unknown_type', 'Clients may only send device-targeted types')
        return
      }
      if (!this.sendCommandToDevice(validated.env)) {
        this.socketError(ws, 'not_in_room', 'The TV is not connected to this pairing session')
      }
      return
    }
    if (!isDeviceToClient(validated.env.type)) {
      this.socketError(ws, 'unknown_type', 'The TV sent a client-only command')
      return
    }
    this.broadcastEnvelope(validated.env)
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string) {
    const attachment = this.socketAttachment(ws)
    if (!attachment) return
    if (attachment.role === 'device' && !this.hasOpenSocket('device')) this.broadcastPresence(false)
    if (attachment.role === 'client' && !this.hasOpenSocket('client')) this.broadcastClientPresence(false)
  }

  webSocketError(_ws: WebSocket, error: unknown) {
    console.warn('SweetSpot room WebSocket error', error)
  }

  async alarm() {
    for (const ws of this.state.getWebSockets()) {
      try { ws.close(1008, 'pairing session expired') } catch {}
    }
  }

  private async openSocket(request: Request, role: SocketAttachment['role']): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }
    const remoteAddress = request.headers.get('X-SweetSpot-Remote-Address') ?? 'unknown'
    const now = Date.now()
    const storedExpiresAt = await this.state.storage.get<number>(EXPIRY_KEY)
    let expiresAt = typeof storedExpiresAt === 'number' && Number.isFinite(storedExpiresAt) && storedExpiresAt > now
      ? storedExpiresAt
      : null
    if (expiresAt === null) {
      for (const ws of this.state.getWebSockets()) {
        try { ws.close(1000, 'pairing session expired') } catch {}
      }
      expiresAt = now + PAIRING_TTL_MS
      await this.state.storage.put(EXPIRY_KEY, expiresAt)
      await this.state.storage.setAlarm(expiresAt)
    }
    const rateKey = `${role}:${remoteAddress}`
    if (await this.rateLimited(`connect:${rateKey}`, CONNECTION_RATE_MAX)) {
      return new Response('connection rate limited', { status: 429 })
    }
    if (role === 'client') {
      const clients = this.state.getWebSockets().filter((ws) => this.socketAttachment(ws)?.role === 'client')
      if (clients.length >= MAX_CLIENTS) return new Response('too many clients', { status: 429 })
    }
    if (role === 'device') {
      for (const ws of this.state.getWebSockets()) {
        if (this.socketAttachment(ws)?.role === 'device' && ws.readyState === WebSocket.OPEN) {
          try { ws.close(1000, 'reconnected authenticated device') } catch {}
        }
      }
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.state.acceptWebSocket(server)
    server.serializeAttachment({
      role,
      rateKey,
      expiresAt,
    } satisfies SocketAttachment)
    this.sendSocket(server, {
      kind: 'room.ready',
      role,
      deviceOnline: this.deviceOnline(),
      messages: [],
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
    if (url.pathname === '/ws' && request.method === 'GET') {
      const role = url.searchParams.get('role')
      if (role !== 'client' && role !== 'device') return new Response('Invalid room socket role', { status: 400 })
      return this.openSocket(request, role)
    }
    return new Response('not found', { status: 404 })
  }
}
