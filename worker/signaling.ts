import { DurableObject } from 'cloudflare:workers'
import {
  MAX_SIGNALING_MESSAGE_BYTES,
  SIGNALING_SUBPROTOCOL,
  isSignalingMessage,
  type SignalingMessage,
  type SignalingRole,
} from '../shared/transport/signaling'
import {
  COMPLETED_RENDEZVOUS_RETENTION_MS,
  isConflictingSignalingGeneration,
  isActiveGenerationAllowed,
  isRendezvousExpired,
  rendezvousCleanupAction,
  rendezvousNextAlarmAt,
  rendezvousRecoveryAnchor,
  shouldForwardSignalingMessage,
} from './signaling-lifetime'

const PAIRING_TTL_MS = 10 * 60 * 1_000
const SECRET_MAX_BYTES = 256
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/
const MAX_SOCKET_COUNT = 4
const MESSAGE_WINDOW_MS = 10_000
const MAX_MESSAGES_PER_WINDOW = 128
const MAX_ICE_CANDIDATES_PER_ATTEMPT = 64
const SECRET_HASH_KEY = 'pair-secret-hash'
const EXPIRY_KEY = 'pair-expiry'
const ACTIVE_KEY = 'active-peer'
const ACTIVE_GENERATION_KEY = 'active-peer-generation'
const GENERATION_KEY = 'peer-generation'
const COMPLETED_AT_KEY = 'completed-at'

interface SocketAttachment {
  role: SignalingRole
  secretHash: string
  hello: boolean
  generation?: string
  messageWindowStartedAt: number
  messagesInWindow: number
  iceAttemptId?: string
  iceCandidateCount: number
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
    const secret = signalingSecretFromRequest(request)
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
    this.closeRedundantPreHelloSockets(role)
    if (this.openSocketCount() >= MAX_SOCKET_COUNT) {
      return jsonError('signaling_busy', 'Too many signaling connections are open for this pairing.', 429)
    }
    if (!storedSecretHash) {
      await this.state.storage.put(SECRET_HASH_KEY, secretHash)
      await this.state.storage.put(EXPIRY_KEY, Date.now() + PAIRING_TTL_MS)
      await this.state.storage.setAlarm(Date.now() + PAIRING_TTL_MS)
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.state.acceptWebSocket(server)
    server.serializeAttachment({
      role,
      secretHash,
      hello: false,
      messageWindowStartedAt: Date.now(),
      messagesInWindow: 0,
      iceCandidateCount: 0,
    } satisfies SocketAttachment)
    this.send(server, {
      v: 1,
      type: 'signal.ready',
      role,
      peerOnline: this.findSocket(oppositeRole(role)) !== null,
    })
    this.notifyPeer(role, true)
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': SIGNALING_SUBPROTOCOL },
    })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let attachment = this.attachment(ws)
    if (attachment) {
      const budget = this.consumeMessageBudget(attachment)
      if (!budget) {
        this.sendError(ws, 'rate_limited', 'Too many signaling messages were sent.')
        try { ws.close(1008, 'signaling rate limit') } catch {}
        return
      }
      attachment = budget
      ws.serializeAttachment(attachment satisfies SocketAttachment)
    }
    if (!attachment || typeof message !== 'string') {
      this.sendError(ws, 'bad_message', 'Signaling accepts JSON messages only.')
      return
    }
    if (new TextEncoder().encode(message).byteLength > MAX_SIGNALING_MESSAGE_BYTES) {
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
      if (attachment.role === 'client' && await this.isActiveGenerationMismatch(value.generation)) {
        this.sendError(ws, 'peer_in_use', 'This TV already has an active dashboard connection.')
        try { ws.close(1008, 'active peer generation') } catch {}
        return
      }
      const other = this.findSocket(attachment.role, ws)
      const otherGeneration = other ? this.attachment(other)?.generation : undefined
      const knownGeneration = await this.state.storage.get<string>(GENERATION_KEY)
      if (other && attachment.role === 'client'
        && isConflictingSignalingGeneration(otherGeneration, value.generation)) {
        this.sendError(ws, attachment.role === 'client' ? 'peer_in_use' : 'device_in_use', 'This peer already has an active signaling connection.')
        try { ws.close(1008, 'peer already connected') } catch {}
        return
      }
      if (other && (attachment.role === 'device' || otherGeneration === value.generation)) {
        try { other.close(1000, 'signaling connection replaced') } catch {}
      }
      ws.serializeAttachment({
        ...attachment,
        hello: true,
        generation: attachment.role === 'client' ? value.generation : attachment.generation,
        iceAttemptId: undefined,
        iceCandidateCount: 0,
      } satisfies SocketAttachment)
      if (attachment.role === 'client' && knownGeneration !== value.generation) {
        await this.state.storage.put(GENERATION_KEY, value.generation)
      }
      this.send(ws, {
        v: 1,
        type: 'signal.peer',
        role: oppositeRole(attachment.role),
        online: this.findSocket(oppositeRole(attachment.role)) !== null,
      })
      this.notifyPeer(attachment.role, true)
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
    if (!attachment.hello) {
      this.sendError(ws, 'bad_message', 'The signaling connection must complete its hello first.')
      return
    }
    if (!knownGeneration || generation !== knownGeneration) {
      this.sendError(ws, 'stale_session', 'The peer session is no longer current.')
      return
    }
    if (attachment.generation !== generation) {
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
    if (value.type === 'signal.offer' || value.type === 'signal.answer') {
      attachment = {
        ...attachment,
        iceAttemptId: value.attemptId,
        iceCandidateCount: 0,
      }
      ws.serializeAttachment(attachment satisfies SocketAttachment)
    } else if (value.type === 'signal.ice') {
      const iceCandidateCount = attachment.iceAttemptId === value.attemptId
        ? attachment.iceCandidateCount + 1
        : 1
      if (iceCandidateCount > MAX_ICE_CANDIDATES_PER_ATTEMPT) {
        this.sendError(ws, 'too_many_ice_candidates', 'Too many ICE candidates were sent for this attempt.')
        try { ws.close(1008, 'ICE candidate limit') } catch {}
        return
      }
      attachment = {
        ...attachment,
        iceAttemptId: value.attemptId,
        iceCandidateCount,
      }
      ws.serializeAttachment(attachment satisfies SocketAttachment)
    }
    if (value.type === 'signal.complete') {
      if (attachment.role !== 'client') {
        this.sendError(ws, 'bad_message', 'Only the dashboard may complete signaling.')
        return
      }
      await this.state.storage.put(ACTIVE_KEY, true)
      await this.state.storage.put(ACTIVE_GENERATION_KEY, generation)
      const completedAt = await this.state.storage.get<number>(COMPLETED_AT_KEY)
      if (typeof completedAt !== 'number') {
        const now = Date.now()
        await this.state.storage.put(COMPLETED_AT_KEY, now)
        await this.state.storage.setAlarm(now + COMPLETED_RENDEZVOUS_RETENTION_MS)
      }
      this.send(ws, {
        v: 1,
        type: 'signal.complete.ack',
        generation,
        attemptId: value.attemptId,
      })
      return
    }
    if (!shouldForwardSignalingMessage(value)) return
    const target = this.findSocket(oppositeRole(attachment.role))
    if (!target) {
      this.sendError(ws, 'peer_offline', 'The other peer is not connected.')
      return
    }
    if (value.type === 'signal.offer') {
      const targetAttachment = this.attachment(target)
      if (!targetAttachment?.hello) {
        this.sendError(ws, 'peer_offline', 'The other peer has not completed signaling setup.')
        return
      }
      if (targetAttachment.generation && targetAttachment.generation !== generation) {
        this.sendError(ws, 'stale_session', 'The peer session is no longer current.')
        return
      }
      target.serializeAttachment({ ...targetAttachment, generation } satisfies SocketAttachment)
      const recoveryAt = rendezvousRecoveryAnchor(
        await this.state.storage.get<boolean>(ACTIVE_KEY) === true,
        await this.state.storage.get<string>(ACTIVE_GENERATION_KEY),
        generation,
      )
      if (recoveryAt !== undefined) {
        await this.state.storage.put(COMPLETED_AT_KEY, recoveryAt)
        await this.state.storage.setAlarm(recoveryAt + COMPLETED_RENDEZVOUS_RETENTION_MS)
      }
    }
    this.send(target, value)
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = this.attachment(ws)
    if (!attachment) return
    if (this.findSocket(attachment.role, ws) !== null) return
    this.notifyPeer(attachment.role, false)
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.warn('SweetSpot signaling WebSocket error', error instanceof Error ? error.message : 'unknown')
    await this.webSocketClose(ws)
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    const active = await this.state.storage.get<boolean>(ACTIVE_KEY) === true
    let completedAt = await this.state.storage.get<number>(COMPLETED_AT_KEY)
    if (active && typeof completedAt !== 'number') {
      completedAt = now
      await this.state.storage.put(COMPLETED_AT_KEY, completedAt)
    }
    if (rendezvousCleanupAction(active, await this.state.storage.get<number>(EXPIRY_KEY), completedAt, now) === 'wait') {
      const nextAlarmAt = rendezvousNextAlarmAt(
        active,
        await this.state.storage.get<number>(EXPIRY_KEY),
        completedAt,
      )
      if (nextAlarmAt !== undefined) {
        await this.state.storage.setAlarm(Math.max(nextAlarmAt, now + 1))
        return
      }
    }
    for (const ws of this.state.getWebSockets()) {
      try { ws.close(1008, 'pairing session expired') } catch {}
    }
    await this.state.storage.deleteAll()
  }

  private attachment(ws: WebSocket): SocketAttachment | null {
    const value = ws.deserializeAttachment()
    if (typeof value !== 'object' || value === null) return null
    const candidate = value as Partial<SocketAttachment>
    if ((candidate.role !== 'client' && candidate.role !== 'device') || typeof candidate.secretHash !== 'string') return null
    return {
      role: candidate.role,
      secretHash: candidate.secretHash,
      hello: candidate.hello === true,
      generation: typeof candidate.generation === 'string' ? candidate.generation : undefined,
      messageWindowStartedAt: typeof candidate.messageWindowStartedAt === 'number'
        ? candidate.messageWindowStartedAt
        : Date.now(),
      messagesInWindow: typeof candidate.messagesInWindow === 'number' ? candidate.messagesInWindow : 0,
      iceAttemptId: typeof candidate.iceAttemptId === 'string' ? candidate.iceAttemptId : undefined,
      iceCandidateCount: typeof candidate.iceCandidateCount === 'number' ? candidate.iceCandidateCount : 0,
    }
  }

  private consumeMessageBudget(attachment: SocketAttachment): SocketAttachment | null {
    const now = Date.now()
    const inCurrentWindow = now - attachment.messageWindowStartedAt < MESSAGE_WINDOW_MS
    const messagesInWindow = inCurrentWindow ? attachment.messagesInWindow + 1 : 1
    if (messagesInWindow > MAX_MESSAGES_PER_WINDOW) return null
    return {
      ...attachment,
      messageWindowStartedAt: inCurrentWindow ? attachment.messageWindowStartedAt : now,
      messagesInWindow,
    }
  }

  private openSocketCount(): number {
    return this.state.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING).length
  }

  private closeRedundantPreHelloSockets(role: SignalingRole): void {
    for (const ws of this.state.getWebSockets()) {
      const attachment = this.attachment(ws)
      if (attachment?.role === role && !attachment.hello && ws.readyState !== WebSocket.CLOSED) {
        try { ws.close(1008, 'redundant signaling connection') } catch {}
      }
    }
  }

  private findSocket(role: SignalingRole, excluded?: WebSocket): WebSocket | null {
    return this.state.getWebSockets().find((ws) => ws !== excluded
      && this.attachment(ws)?.role === role
      && this.attachment(ws)?.hello === true
      && ws.readyState === WebSocket.OPEN) ?? null
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

function signalingSecretFromRequest(request: Request): string | null {
  const header = request.headers.get('Sec-WebSocket-Protocol')
  if (!header) return null
  const protocols = header.split(',').map((protocol) => protocol.trim()).filter(Boolean)
  if (protocols.length !== 2 || !protocols.includes(SIGNALING_SUBPROTOCOL)) return null
  return protocols.find((protocol) => protocol !== SIGNALING_SUBPROTOCOL) ?? null
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
