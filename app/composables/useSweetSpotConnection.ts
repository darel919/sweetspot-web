import { onScopeDispose, readonly, ref, shallowRef } from 'vue'
import {
  PROTOCOL_VERSION,
  isEnvelope,
  isRoomSocketServerMessage,
  type Envelope,
  type Role,
} from '#shared/types/protocol'
import {
  connectionStateForDevice,
  type ConnectionState,
} from './connectionState'
import {
  enqueuePendingEnvelope,
  flushPendingEnvelopes,
  MAX_PENDING_ENVELOPES,
} from '../lib/transport/outbox'
import { SweetSpotRequestError } from '../lib/transport/errors'

const SOCKET_RECONNECT_MIN_MS = 800
const SOCKET_RECONNECT_MAX_MS = 10_000
const REQUEST_TIMEOUT_MS = 15_000
const COALESCED_COMMAND_TYPES = ['engine.setBands', 'state.get'] as const

let messageCounter = 0

function nextMessageId(): string {
  return `msg_${Date.now().toString(36)}_${(messageCounter++).toString(36)}`
}

function roomUrl(code: string, action: string): string {
  return `/api/room/${encodeURIComponent(code)}/${action}`
}

function roomSocketUrl(code: string, role: Role): string {
  const url = new URL(roomUrl(code, `ws?role=${encodeURIComponent(role)}`), window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export function useSweetSpotConnection(role: Role, pairCode: () => string) {
  const status = ref<ConnectionState>('disconnected')
  const deviceOnline = ref(false)
  const lastMessage = shallowRef<Envelope | null>(null)
  const debugLog = shallowRef<Array<{ at: number; direction: 'in' | 'out'; text: string }>>([])

  let disposed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let socket: WebSocket | null = null
  let socketReady = false
  let socketAttempts = 0
  let pendingEnvelopes: Envelope[] = []
  const pendingRequests = new Map<string, { cleanup: () => void; reject: (reason: SweetSpotRequestError) => void }>()

  const handlers = new Set<(env: Envelope) => void>()
  const seenMessageIds = new Set<string>()

  function log(direction: 'in' | 'out', text: string) {
    debugLog.value = [...debugLog.value.slice(-99), { at: Date.now(), direction, text }]
  }

  function makeEnvelope(type: string, payload: unknown, replyTo?: string): Envelope {
    const timestamp = Date.now()
    return {
      v: PROTOCOL_VERSION,
      id: nextMessageId(),
      type,
      ts: timestamp,
      payload,
      ...(role === 'client' ? { expiresAt: timestamp + 30_000 } : {}),
      ...(replyTo ? { replyTo } : {}),
    }
  }

  function markConnectionInterrupted() {
    if (disposed) return
    deviceOnline.value = false
    status.value = 'offline'
  }

  function deliver(env: Envelope) {
    if (seenMessageIds.has(env.id)) return
    seenMessageIds.add(env.id)
    if (seenMessageIds.size > 512) {
      const first = seenMessageIds.values().next().value
      if (first) seenMessageIds.delete(first)
    }
    lastMessage.value = env
    log('in', JSON.stringify(env))
    if (env.type === 'pong') return
    for (const handler of handlers) handler(env)
  }

  function dispatch(env: Envelope): boolean {
    if (!socketReady || socket?.readyState !== WebSocket.OPEN) return false
    try {
      socket.send(JSON.stringify(env))
      return true
    } catch {
      markConnectionInterrupted()
      socket?.close()
      return false
    }
  }

  function flushPending() {
    pendingEnvelopes = flushPendingEnvelopes(pendingEnvelopes, dispatch, Date.now())
  }

  function dispatchOrQueue(env: Envelope) {
    if (dispatch(env) || disposed) return
    pendingEnvelopes = enqueuePendingEnvelope(pendingEnvelopes, env, Date.now(), {
      max: MAX_PENDING_ENVELOPES,
      coalesceTypes: COALESCED_COMMAND_TYPES,
    })
  }

  function send(type: string, payload: unknown = {}, replyTo?: string): string {
    const env = makeEnvelope(type, payload, replyTo)
    log('out', JSON.stringify(env))
    dispatchOrQueue(env)
    return env.id
  }

  function request<T = unknown>(
    type: string,
    payload: unknown = {},
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Envelope<T>> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new SweetSpotRequestError('aborted', type))
        return
      }
      const env = makeEnvelope(type, payload)
      const timeoutMs = Math.max(1, options.timeoutMs ?? REQUEST_TIMEOUT_MS)
      let timeout: ReturnType<typeof setTimeout> | null = null
      let abortListener: (() => void) | null = null
      const handler = (incoming: Envelope) => {
        if (incoming.replyTo !== env.id) return
        const pending = pendingRequests.get(env.id)
        if (!pending) return
        pending.cleanup()
        pendingRequests.delete(env.id)
        resolve(incoming as Envelope<T>)
      }
      const off = () => handlers.delete(handler)
      const removeQueued = () => {
        pendingEnvelopes = pendingEnvelopes.filter((candidate) => candidate.id !== env.id)
      }
      const cleanup = () => {
        off()
        removeQueued()
        if (timeout !== null) clearTimeout(timeout)
        if (abortListener) options.signal?.removeEventListener('abort', abortListener)
      }
      const rejectRequest = (reason: SweetSpotRequestError) => {
        const pending = pendingRequests.get(env.id)
        if (!pending) return
        pending.cleanup()
        pendingRequests.delete(env.id)
        reject(reason)
      }
      handlers.add(handler)
      timeout = setTimeout(() => rejectRequest(new SweetSpotRequestError('timeout', type)), timeoutMs)
      if (options.signal) {
        abortListener = () => rejectRequest(new SweetSpotRequestError('aborted', type))
        options.signal.addEventListener('abort', abortListener, { once: true })
      }
      pendingRequests.set(env.id, { cleanup, reject: rejectRequest })
      log('out', JSON.stringify(env))
      dispatchOrQueue(env)
    })
  }

  function rejectPendingRequests(kind: 'connection' | 'disposed') {
    for (const pending of pendingRequests.values()) pending.reject(new SweetSpotRequestError(kind, 'transport'))
    pendingRequests.clear()
  }

  function onMessage(handler: (env: Envelope) => void): () => void {
    handlers.add(handler)
    return () => handlers.delete(handler)
  }

  function applySocketMessage(value: unknown) {
    if (isEnvelope(value)) {
      deliver(value)
      return
    }
    if (!isRoomSocketServerMessage(value)) return
    if (value.kind === 'room.ready') {
      const wasOnline = deviceOnline.value
      deviceOnline.value = value.deviceOnline
      status.value = connectionStateForDevice(value.deviceOnline)
      for (const env of value.messages) deliver(env)
      if (!wasOnline && value.deviceOnline) send('state.get')
      return
    }
    if (value.kind === 'room.presence') {
      const wasOnline = deviceOnline.value
      deviceOnline.value = value.deviceOnline
      status.value = connectionStateForDevice(value.deviceOnline)
      if (!wasOnline && value.deviceOnline) send('state.get')
      return
    }
    log('in', JSON.stringify(value))
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer !== null) return
    socketAttempts++
    const delay = Math.min(
      SOCKET_RECONNECT_MIN_MS * (2 ** Math.max(0, socketAttempts - 1)),
      SOCKET_RECONNECT_MAX_MS,
    )
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      openSocket()
    }, delay)
  }

  function openSocket() {
    if (disposed || socket !== null) return
    let next: WebSocket
    try {
      next = new WebSocket(roomSocketUrl(pairCode(), role))
    } catch {
      markConnectionInterrupted()
      scheduleReconnect()
      return
    }
    socket = next
    next.onopen = () => {
      if (socket !== next || disposed) return
      socketReady = true
      socketAttempts = 0
      flushPending()
      status.value = 'connecting'
    }
    next.onmessage = (event) => {
      if (socket !== next || disposed) return
      let value: unknown
      try {
        value = JSON.parse(typeof event.data === 'string' ? event.data : '')
      } catch {
        return
      }
      applySocketMessage(value)
    }
    next.onerror = () => {
      if (socket === next) next.close()
    }
    next.onclose = () => {
      if (socket !== next) return
      socket = null
      socketReady = false
      if (disposed) return
      markConnectionInterrupted()
      rejectPendingRequests('connection')
      scheduleReconnect()
    }
  }

  function connect() {
    if (disposed || !pairCode()) return
    if (socket !== null || reconnectTimer !== null) return
    status.value = 'connecting'
    openSocket()
  }

  function disconnect() {
    disposed = true
    if (reconnectTimer !== null) clearTimeout(reconnectTimer)
    reconnectTimer = null
    socket?.close()
    socket = null
    socketReady = false
    pendingEnvelopes = []
    rejectPendingRequests('disposed')
    status.value = 'disconnected'
  }

  onScopeDispose(disconnect)

  return {
    status: readonly(status),
    deviceOnline: readonly(deviceOnline),
    lastMessage,
    debugLog,
    connect,
    disconnect,
    send,
    request,
    onMessage,
  }
}
