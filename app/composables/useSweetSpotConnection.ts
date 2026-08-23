import { onScopeDispose, readonly, ref, shallowRef } from 'vue'
import {
  PROTOCOL_VERSION,
  type Envelope,
  type HelloPayload,
  type Role,
} from '#shared/types/protocol'

export type ConnectionState = 'disconnected' | 'connecting' | 'connected'

const HEARTBEAT_INTERVAL_MS = 20_000
const MAX_MISSED_PONGS = 2

let messageCounter = 0

function nextMessageId(): string {
  return `msg_${Date.now().toString(36)}_${(messageCounter++).toString(36)}`
}

/**
 * Direct same-origin WebSocket to the TV (the page itself is served by the TV).
 * role "client" joins the room advertised in the QR code; the TV owns the room.
 */
export function useSweetSpotConnection(role: Role, pairCode: () => string) {
  const status = ref<ConnectionState>('disconnected')
  const lastMessage = shallowRef<Envelope | null>(null)
  const debugLog = shallowRef<Array<{ at: number; direction: 'in' | 'out' | 'sys'; text: string }>>([])

  let ws: WebSocket | null = null
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let missedPongs = 0
  let disposed = false

  const handlers = new Set<(env: Envelope) => void>()

  function log(direction: 'in' | 'out' | 'sys', text: string) {
    debugLog.value = [...debugLog.value.slice(-99), { at: Date.now(), direction, text }]
  }

  function send(type: string, payload: unknown = {}, replyTo?: string): string {
    const env: Envelope = {
      v: PROTOCOL_VERSION,
      id: nextMessageId(),
      type,
      ts: Date.now(),
      payload,
      ...(replyTo ? { replyTo } : {}),
    }
    ws?.send(JSON.stringify(env))
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

  function clearTimers() {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    heartbeatTimer = null
    reconnectTimer = null
  }

  function scheduleReconnect() {
    if (disposed) return
    status.value = 'connecting'
    const delay = Math.min(1000 * 2 ** reconnectAttempt, 15_000) * (0.5 + Math.random() * 0.5)
    reconnectTimer = setTimeout(connect, delay)
    reconnectAttempt++
  }

  function startHeartbeat() {
    missedPongs = 0
    heartbeatTimer = setInterval(() => {
      missedPongs++
      if (missedPongs > MAX_MISSED_PONGS) {
        ws?.close()
        return
      }
      send('ping')
    }, HEARTBEAT_INTERVAL_MS)
  }

  function connect() {
    if (disposed || !pairCode()) return
    clearTimers()
    status.value = 'connecting'

    // Same origin: the TV serves this page.
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${location.host}/api/ws?room=${encodeURIComponent(pairCode())}&role=${role}`
    try {
      ws = new WebSocket(url)
    } catch {
      scheduleReconnect()
      return
    }

    ws.addEventListener('open', () => {
      reconnectAttempt = 0
      const hello: HelloPayload = { role, room: pairCode() }
      send('session.hello', hello)
    })

    ws.addEventListener('message', (event) => {
      let env: Partial<Envelope>
      try {
        env = JSON.parse(typeof event.data === 'string' ? event.data : '')
      } catch {
        return
      }
      if (typeof env.type !== 'string') return
      if (env.type === 'pong') missedPongs = 0

      const full = { ...env } as Envelope
      lastMessage.value = full

      if (env.type === 'session.welcome') {
        status.value = 'connected'
        startHeartbeat()
      }
      for (const handler of handlers) handler(full)
    })

    ws.addEventListener('close', () => {
      status.value = 'disconnected'
      clearTimers()
      scheduleReconnect()
    })
    ws.addEventListener('error', () => ws?.close())
  }

  function disconnect() {
    disposed = true
    clearTimers()
    ws?.close()
    ws = null
    status.value = 'disconnected'
  }

  onScopeDispose(disconnect)

  return {
    status: readonly(status),
    lastMessage,
    debugLog,
    connect,
    disconnect,
    send,
    request,
    onMessage,
  }
}
