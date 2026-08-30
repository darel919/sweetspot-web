import {
  decodeSignalingMessage,
  encodeSignalingMessage,
  SIGNALING_SUBPROTOCOL,
  type PairingCredentials,
  type SignalingMessage,
} from '#shared/transport/signaling'
import type { SignalingRole } from '#shared/transport/signaling'

export interface SignalingClientHandlers {
  onMessage: (message: SignalingMessage) => void
  onClose: (reason: string) => void
}

export interface SignalingClient {
  connect(pairing: PairingCredentials, generation: string): Promise<void>
  send(message: SignalingMessage): boolean
  suspend(): void
  close(): void
}

function signalingSocketUrl(pairing: PairingCredentials, role: SignalingRole): string {
  const url = new URL(`/api/signaling/${encodeURIComponent(pairing.rendezvousId)}/ws`, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('role', role)
  return url.toString()
}

export function createSignalingClient(role: SignalingRole, handlers: SignalingClientHandlers): SignalingClient {
  let socket: WebSocket | null = null
  let opening: Promise<void> | null = null
  let cancelOpening: (() => void) | null = null
  let closed = false

  function closeSocket(reason: string): void {
    const current = socket
    socket = null
    if (current) current.close(1000, reason)
    handlers.onClose(reason)
  }

  function connect(pairing: PairingCredentials, generation: string): Promise<void> {
    if (closed) return Promise.reject(new Error('Signaling client is closed'))
    if (socket?.readyState === WebSocket.OPEN) return Promise.resolve()
    if (opening) return opening
    opening = new Promise<void>((resolve, reject) => {
      let settled = false
      cancelOpening = () => {
        if (settled) return
        settled = true
        opening = null
        cancelOpening = null
        reject(new Error('Signaling connection was suspended.'))
      }
      let next: WebSocket
      try {
        next = new WebSocket(signalingSocketUrl(pairing, role), [SIGNALING_SUBPROTOCOL, pairing.pairSecret])
      } catch (error: unknown) {
        opening = null
        cancelOpening = null
        reject(error instanceof Error ? error : new Error('Signaling could not start.'))
        return
      }
      socket = next
      next.onopen = () => {
        if (socket !== next || closed) return
        try {
          next.send(encodeSignalingMessage({ v: 1, type: 'signal.hello', generation }))
        } catch {
          if (!settled) {
            settled = true
            opening = null
            cancelOpening = null
            reject(new Error('Signaling hello failed.'))
          }
          closeSocket('signaling hello failed')
          return
        }
        settled = true
        opening = null
        cancelOpening = null
        resolve()
      }
      next.onmessage = (event: MessageEvent<unknown>) => {
        if (socket !== next || typeof event.data !== 'string') return
        const message = decodeSignalingMessage(event.data)
        if (message) handlers.onMessage(message)
        else closeSocket('Signaling sent an invalid message.')
      }
      next.onerror = () => {
        if (socket !== next) return
        if (!settled) {
          opening = null
          cancelOpening = null
          reject(new Error('Signaling service is unavailable.'))
        }
        closeSocket('signaling socket error')
      }
      next.onclose = (event: CloseEvent) => {
        if (socket !== next) return
        socket = null
        opening = null
        cancelOpening = null
        if (!settled) reject(new Error(`Signaling connection closed (${event.code}).`))
        handlers.onClose(event.reason || 'Signaling connection closed.')
      }
    })
    return opening
  }

  return {
    connect,
    send(message) {
      if (socket?.readyState !== WebSocket.OPEN) return false
      try {
        socket.send(encodeSignalingMessage(message))
        return true
      } catch {
        closeSocket('signaling send failed')
        return false
      }
    },
    suspend() {
      cancelOpening?.()
      const current = socket
      socket = null
      if (current) current.close(1000, 'signaling suspended')
    },
    close() {
      closed = true
      cancelOpening?.()
      opening = null
      closeSocket('signaling closed')
    },
  }
}
