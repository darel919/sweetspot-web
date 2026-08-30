import { onMounted, onScopeDispose, readonly, ref, shallowRef } from 'vue'
import type { Envelope, Role } from '#shared/types/protocol'
import type { PairingCredentials } from '#shared/transport/signaling'
import { createWebRtcTransport } from '~/lib/transport/webrtc/peer'
import type {
  DirectConnectionState,
  SweetSpotTransport,
  SweetSpotTransportFactory,
  TransportDiagnostics,
} from '~/lib/transport/types'
import { connectionStateForTransport, type ConnectionState } from './connectionState'

export interface SweetSpotConnectionOptions {
  createTransport?: SweetSpotTransportFactory
}

const SENSITIVE_KEY = /secret|token|password|authorization/i
const SESSION_KEY = /session(?:id)?$/i

function redactDebugValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[redacted]'
  if (SESSION_KEY.test(key) && typeof value === 'string') return `…${value.slice(-8)}`
  if (Array.isArray(value)) return value.map((item) => redactDebugValue(item))
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
    childKey,
    redactDebugValue(childValue, childKey),
  ]))
}

function debugJson(value: unknown): string {
  try {
    return JSON.stringify(redactDebugValue(value)) ?? '[unserializable]'
  } catch {
    return '[unserializable]'
  }
}

export function useSweetSpotConnection(
  role: Role,
  pairing: () => PairingCredentials | null,
  options: SweetSpotConnectionOptions = {},
) {
  const status = ref<ConnectionState>('disconnected')
  const transportState = ref<DirectConnectionState>('idle')
  const deviceOnline = ref(false)
  const lastMessage = shallowRef<Envelope | null>(null)
  const debugLog = shallowRef<Array<{ at: number; direction: 'in' | 'out'; text: string }>>([])
  const diagnostics = shallowRef<TransportDiagnostics | null>(null)

  let disposed = false
  const transport: SweetSpotTransport = (options.createTransport ?? (() => createWebRtcTransport(role)))()

  function log(direction: 'in' | 'out', value: unknown): void {
    debugLog.value = [...debugLog.value.slice(-99), { at: Date.now(), direction, text: debugJson(value) }]
  }

  function setTransportState(next: DirectConnectionState): void {
    transportState.value = next
    status.value = connectionStateForTransport(next)
    deviceOnline.value = next === 'direct'
    if (next === 'direct') transport.send('state.get')
  }

  const removeStateListener = transport.onStateChange(setTransportState)
  const removeDiagnosticsListener = transport.onDiagnostics((next) => {
    diagnostics.value = next
  })
  const removeMessageListener = transport.onMessage((env) => {
    lastMessage.value = env
    log('in', env)
  })

  function connect(): void {
    if (disposed) return
    const nextPairing = pairing()
    if (!nextPairing) {
      setTransportState('failed')
      return
    }
    transport.connect(nextPairing)
  }

  function disconnect(): void {
    if (disposed) return
    disposed = true
    removeStateListener()
    removeDiagnosticsListener()
    removeMessageListener()
    transport.disconnect()
    status.value = 'disconnected'
    transportState.value = 'closed'
    deviceOnline.value = false
  }

  function send(type: string, payload: unknown = {}, replyTo?: string): string {
    const id = transport.send(type, payload, replyTo)
    log('out', { type, payload, replyTo, id })
    return id
  }

  function request<T = unknown>(
    type: string,
    payload: unknown = {},
    requestOptions: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Envelope<T>> {
    log('out', { type, payload })
    return transport.request<T>(type, payload, requestOptions)
  }

  function onMessage(handler: (env: Envelope) => void): () => void {
    return transport.onMessage(handler)
  }

  function onPageHide(event: PageTransitionEvent): void {
    if (event.persisted) return
    disconnect()
  }

  function onPageShow(event: PageTransitionEvent): void {
    if (!event.persisted || disposed) return
    connect()
  }

  onMounted(() => {
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
  })

  onScopeDispose(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
    }
    disconnect()
  })

  return {
    state: () => transport.state,
    status: readonly(status),
    transportState: readonly(transportState),
    deviceOnline: readonly(deviceOnline),
    lastMessage,
    debugLog,
    diagnostics: readonly(diagnostics),
    sessionId: () => transport.diagnostics().sessionId,
    connect,
    disconnect,
    onStateChange: transport.onStateChange,
    send,
    sendCaptureFrame: transport.sendCaptureFrame,
    request,
    onMessage,
  }
}
