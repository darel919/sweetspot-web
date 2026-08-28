import { DurableObject } from 'cloudflare:workers'
import {
  isSignalingMessage,
  type SignalingMessage,
  type SignalingRole,
} from '../shared/transport/signaling'
import { isActiveGenerationAllowed, isRendezvousExpired } from './signaling-lifetime'

const PAIRING_TTL_MS = 10 * 60 * 1_000
const SECRET_MAX_BYTES = 256
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/
const SECRET_HASH_KEY = 'pair-secret-hash'
const EXPIRY_KEY = 'pair-expiry'
const ACTIVE_KEY = 'active-peer'
const ACTIVE_GENERATION_KEY = 'active-peer-generation'
const GENERATION_KEY = 'peer-generation'

interface SocketAttachment {
  role: SignalingRole
  secretHash: string
}

export class SignalingDO extends DurableObject<unknown> {
  private readonly state: DurableObjectState

  constructor(state: DurableObjectState, env: unknown) {
    super(state, env)
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }
    const url = new URL(request.url)
    const role = url.searchParams.get('role')
    const secret = url.searchParams.get('secret')
    if ((role !== 'client' && role !== 'device') || !secret || !SECRET_PATTERN.test(secret)
      || new TextEncoder().encode(secret).byteLength > SECRET_MAX_BYTES) {
      return jsonError('invalid_pairing', 'This pairing link is invalid or incomplete.', 400)
    }
    if (role === 'client' && !clientOriginAllowed(request)) {
      return jsonError('origin_rejected', 'The dashboard origin is not allowed.', 403)
    }

    const secretHash = await digestHex(secret)
    const storedSecretHash = await this.state.storage.get<string>(SECRET_HASH_KEY)
    const active = await this.state.storage.get<boolean>(ACTIVE_KEY) === true
    const expiresAt = await this.state.storage.get<number>(EXPIRY_KEY)
    if (storedSecretHash && !constantTimeEqual(storedSecretHash, secretHash)) {
      return jsonError('invalid_pairing', 'This pairing link is invalid or incomplete.', 403)
    }
    if (storedSecretHash && isRendezvousExpired(active, expiresAt)) {
      return jsonError('pairing_expired', 'This pairing link has expired. Scan the current QR code on the TV.', 410)
    }
    if (role === 'client' && this.hasOpenSocket('client')) {
      return jsonError('peer_in_use', 'This TV already has an active dashboard connection.', 409)
    }
    if (role === 'device' && this.hasOpenSocket('device')) {
      return jsonError('device_in_use', 'This TV already has an active signaling connection.', 409)
    }

    if (!storedSecretHash) {
      await this.state.storage.put(SECRET_HASH_KEY, secretHash)
      await this.state.storage.put(EXPIRY_KEY, Date.now() + PAIRING_TTL_MS)
      await this.state.storage.setAlarm(Date.now() + PAIRING_TTL_MS)
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.state.acceptWebSocket(server)
    server.serializeAttachment({ role, secretHash } satisfies SocketAttachment)
    this.send(server, {
      v: 1,
      type: 'signal.ready',
      role,
      peerOnline: this.hasOpenSocket(oppositeRole(role)),
    })
    this.notifyPeer(role, true)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = this.attachment(ws)
    if (!attachment || typeof message !== 'string') {
      this.sendError(ws, 'bad_message', 'Signaling accepts JSON messages only.')
      return
    }
    if (new TextEncoder().encode(message).byteLength > 64 * 1024) {
      this.sendError(ws, 'payload_too_large', 'The signaling message is too large.')
      return
    }
    let value: unknown
    try {
      value = JSON.parse(message)
    } catch {
      this.sendError(ws, 'bad_json', 'The signaling message is not valid JSON.')
      return
    }
    if (!isSignalingMessage(value)) {
      this.sendError(ws, 'bad_message', 'The signaling message is invalid.')
      return
    }
    if (value.type === 'signal.hello') {
      if (await this.isActiveGenerationMismatch(value.generation)) {
        this.sendError(ws, 'peer_in_use', 'This TV already has an active dashboard connection.')
        try { ws.close(1008, 'active peer generation') } catch {}
        return
      }
      if (attachment.role === 'client') await this.state.storage.put(GENERATION_KEY, value.generation)
      return
    }
    if (value.type === 'signal.ready' || value.type === 'signal.peer' || value.type === 'signal.error') {
      this.sendError(ws, 'bad_message', 'Only the signaling service may send status messages.')
      return
    }
    if (!['signal.offer', 'signal.answer', 'signal.ice', 'signal.complete'].includes(value.type)) {
      this.sendError(ws, 'bad_message', 'This message is not part of the signaling contract.')
      return
    }
    const generation = value.generation
    const knownGeneration = await this.state.storage.get<string>(GENERATION_KEY)
    if (!knownGeneration || generation !== knownGeneration) {
      this.sendError(ws, 'stale_session', 'The peer session is no longer current.')
      return
    }
    if (value.type === 'signal.offer' && attachment.role !== 'client') {
      this.sendError(ws, 'bad_message', 'Only the dashboard may send an offer.')
      return
    }
    if (value.type === 'signal.answer' && attachment.role !== 'device') {
      this.sendError(ws, 'bad_message', 'Only the TV may send an answer.')
      return
    }
    if (value.type === 'signal.complete') {
      if (attachment.role !== 'client') {
        this.sendError(ws, 'bad_message', 'Only the dashboard may complete signaling.')
        return
      }
      await this.state.storage.put(ACTIVE_KEY, true)
      await this.state.storage.put(ACTIVE_GENERATION_KEY, generation)
    }
    const target = this.findSocket(oppositeRole(attachment.role))
    if (!target) {
      this.sendError(ws, 'peer_offline', 'The other peer is not connected.')
      return
    }
    this.send(target, value)
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = this.attachment(ws)
    if (!attachment) return
    this.notifyPeer(attachment.role, false)
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.warn('SweetSpot signaling WebSocket error', error instanceof Error ? error.message : 'unknown')
    await this.webSocketClose(ws)
  }

  async alarm(): Promise<void> {
    if (await this.state.storage.get<boolean>(ACTIVE_KEY) === true) return
    for (const ws of this.state.getWebSockets()) {
      try { ws.close(1008, 'pairing session expired') } catch {}
    }
    await this.state.storage.deleteAll()
  }

  private attachment(ws: WebSocket): SocketAttachment | null {
    const value = ws.deserializeAttachment()
    if (typeof value !== 'object' || value === null) return null
    const candidate = value as Partial<SocketAttachment>
    return (candidate.role === 'client' || candidate.role === 'device') && typeof candidate.secretHash === 'string'
      ? candidate as SocketAttachment
      : null
  }

  private hasOpenSocket(role: SignalingRole): boolean {
    return this.findSocket(role) !== null
  }

  private findSocket(role: SignalingRole): WebSocket | null {
    return this.state.getWebSockets().find((ws) => this.attachment(ws)?.role === role && ws.readyState === WebSocket.OPEN) ?? null
  }

  private notifyPeer(sourceRole: SignalingRole, online: boolean): void {
    const target = this.findSocket(oppositeRole(sourceRole))
    if (!target) return
    this.send(target, {
      v: 1,
      type: 'signal.peer',
      role: sourceRole,
      online,
    })
  }

  private send(ws: WebSocket, message: SignalingMessage): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(message))
      return true
    } catch {
      try { ws.close(1011, 'signaling send failed') } catch {}
      return false
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    this.send(ws, { v: 1, type: 'signal.error', code, message })
  }

  private async isActiveGenerationMismatch(generation: string): Promise<boolean> {
    if (await this.state.storage.get<boolean>(ACTIVE_KEY) !== true) return false
    const activeGeneration = await this.state.storage.get<string>(ACTIVE_GENERATION_KEY)
    return !isActiveGenerationAllowed(activeGeneration, generation)
  }
}

function oppositeRole(role: SignalingRole): SignalingRole {
  return role === 'client' ? 'device' : 'client'
}

function clientOriginAllowed(request: Request): boolean {
  const origin = request.headers.get('Origin')
  if (origin === null) return false
  return origin === new URL(request.url).origin
    || origin === 'http://localhost:3000'
    || origin === 'http://127.0.0.1:3000'
}

async function digestHex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}

function jsonError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
