import { onScopeDispose, readonly, ref, shallowRef } from 'vue'
import {
  PROTOCOL_VERSION,
  isEnvelope,
  type Envelope,
  type Role,
} from '#shared/types/protocol'
import {
  connectionStateForDevice,
  type ConnectionState,
} from './connectionState'

interface RoomStateResponse {
  deviceOnline: boolean
  messages: Envelope[]
}

const CLIENT_POLL_MS = 1200

let messageCounter = 0

function nextMessageId(): string {
  return `msg_${Date.now().toString(36)}_${(messageCounter++).toString(36)}`
}

function roomUrl(code: string, action: string): string {
  return `/api/room/${encodeURIComponent(code)}/${action}`
}

function isRoomStateResponse(value: unknown): value is RoomStateResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('deviceOnline' in value) || typeof value.deviceOnline !== 'boolean') return false
  if (!('messages' in value) || !Array.isArray(value.messages)) return false
  return value.messages.every(isEnvelope)
}

/**
 * Polling client for the phone/laptop dashboard.
 * Posts commands and polls device-published messages from the room mailbox.
 * No persistent connection: plain fetch works everywhere, including iOS Safari.
 */
export function useSweetSpotConnection(role: Role, pairCode: () => string) {
  const status = ref<ConnectionState>('disconnected')
  const deviceOnline = ref(false)
  const lastMessage = shallowRef<Envelope | null>(null)
  const debugLog = shallowRef<Array<{ at: number; direction: 'in' | 'out'; text: string }>>([])

  let disposed = false
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let since = 0

  const handlers = new Set<(env: Envelope) => void>()

  function log(direction: 'in' | 'out', text: string) {
    debugLog.value = [...debugLog.value.slice(-99), { at: Date.now(), direction, text }]
  }

  function makeEnvelope(type: string, payload: unknown, replyTo?: string): Envelope {
    return {
      v: PROTOCOL_VERSION,
      id: nextMessageId(),
      type,
      ts: Date.now(),
      payload,
      ...(replyTo ? { replyTo } : {}),
    }
  }

  function markConnectionInterrupted() {
    if (!disposed && status.value === 'connected') status.value = 'connecting'
  }

  async function post(env: Envelope): Promise<boolean> {
    try {
      const res = await fetch(roomUrl(pairCode(), role === 'client' ? 'client' : 'device'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(env),
      })
      if (!res.ok) markConnectionInterrupted()
      return res.ok
    } catch {
      markConnectionInterrupted()
      return false
    }
  }

  function send(type: string, payload: unknown = {}, replyTo?: string): string {
    const env = makeEnvelope(type, payload, replyTo)
    log('out', JSON.stringify(env))
    void post(env)
    return env.id
  }

  function request<T = unknown>(type: string, payload: unknown = {}): Promise<Envelope<T>> {
    return new Promise((resolve) => {
      const id = send(type, payload)
      const off = onMessage((env) => {
        if (env.replyTo !== id) return
        off()
        resolve(env as Envelope<T>)
      })
    })
  }

  function onMessage(handler: (env: Envelope) => void): () => void {
    handlers.add(handler)
    return () => handlers.delete(handler)
  }

  async function pollOnce() {
    if (disposed) return
    try {
      const res = await fetch(roomUrl(pairCode(), `state?since=${since}`))
      if (!res.ok) throw new Error(`state request failed with HTTP ${res.status}`)
      const raw: unknown = await res.json()
      if (!isRoomStateResponse(raw)) throw new Error('state response was malformed')
      if (disposed) return

      const wasOnline = deviceOnline.value
      deviceOnline.value = raw.deviceOnline
      status.value = connectionStateForDevice(raw.deviceOnline)
      for (const env of raw.messages) {
        since = Math.max(since, Date.now() - 1)
        lastMessage.value = env
        log('in', JSON.stringify(env))
        if (env.type === 'pong') continue
        for (const handler of handlers) handler(env)
      }
      if (!wasOnline && deviceOnline.value) {
        void send('state.get')
      }
    } catch {
      if (!disposed) status.value = 'connecting'
    }
    if (!disposed) {
      pollTimer = setTimeout(pollOnce, CLIENT_POLL_MS)
    }
  }

  function connect() {
    if (disposed || !pairCode()) return
    if (pollTimer !== null) return
    status.value = 'connecting'
    void pollOnce()
  }

  function disconnect() {
    disposed = true
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
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
