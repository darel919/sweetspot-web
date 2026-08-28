import type { Envelope } from '#shared/types/protocol'
import type { PairingCredentials } from '#shared/transport/signaling'

export type DirectConnectionState =
  | 'idle'
  | 'pairing'
  | 'signaling'
  | 'connecting'
  | 'direct'
  | 'reconnecting'
  | 'failed'
  | 'closed'

export type TransportFailureKind =
  | 'microphone'
  | 'acoustic'
  | 'tv_audio'
  | 'p2p'
  | 'signaling'
  | 'protocol'
  | 'cancelled'

export type { PairingCredentials }

export interface TransportError {
  kind: TransportFailureKind
  code: string
  message: string
  retryable: boolean
}

export interface TransportDiagnostics {
  state: DirectConnectionState
  sessionId: string | null
  iceConnectionState: string | null
  iceGatheringState: string | null
  peerConnectionState: string | null
  selectedCandidateType: string | null
  selectedCandidateProtocol: string | null
  rttMs: number | null
  bytesSent: number
  bytesReceived: number
  captureBufferedBytes: number
  reconnectCount: number
  signalingRoundTripMs: number | null
  lastControlMessageAt: number | null
  lastPeerTrafficAt: number | null
  lastError: TransportError | null
}

export interface TransportRequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface SweetSpotTransport {
  readonly state: DirectConnectionState
  connect(pairing: PairingCredentials): void
  disconnect(): void
  send(type: string, payload?: unknown, replyTo?: string): string
  request<T = unknown>(
    type: string,
    payload?: unknown,
    options?: TransportRequestOptions,
  ): Promise<Envelope<T>>
  sendCaptureFrame(frame: ArrayBuffer): Promise<void>
  onMessage(handler: (env: Envelope) => void): () => void
  onStateChange(handler: (state: DirectConnectionState) => void): () => void
  onDiagnostics(handler: (diagnostics: TransportDiagnostics) => void): () => void
  diagnostics(): TransportDiagnostics
}

export type SweetSpotTransportFactory = () => SweetSpotTransport
