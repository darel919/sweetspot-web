import {
  localTransportCapabilities,
  MAX_CAPTURE_CHUNK_BYTES,
  MAX_CAPTURE_FRAME_BYTES,
  type TransportCapabilityMessage,
  type TransportCapabilities,
} from '#shared/transport/capabilities'
import {
  isSignalingMessage,
  type PairingCredentials,
  type SignalingMessage,
} from '#shared/transport/signaling'
import {
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  isClientToDevice,
  serializedUtf8ByteLength,
  type Envelope,
  type Role,
  validatePayload,
  utf8ByteLength,
} from '#shared/types/protocol'
import { SweetSpotRequestError } from '../errors'
import { sessionIdForPairing } from '../../pairing/session'
import { createSignalingClient, type SignalingClient } from '../signaling/client'
import { BoundedCaptureQueue } from './backpressure'
import { bindCaptureChannel } from './capture-channel'
import { bindControlChannel, parseControlMessage } from './control-channel'
import { readPeerStats } from './stats'
import type {
  DirectConnectionState,
  SweetSpotTransport,
  TransportDiagnostics,
  TransportError,
  TransportRequestOptions,
} from '../types'

const CONTROL_CHANNEL = 'control'
const CAPTURE_CHANNEL = 'capture'
const CAPTURE_HIGH_WATER_BYTES = 256 * 1024
const CAPTURE_LOW_WATER_BYTES = 64 * 1024
const CONTROL_HIGH_WATER_BYTES = 256 * 1024
const CONTROL_LOW_WATER_BYTES = 64 * 1024
const MAX_PENDING_CONTROL = 128
const MAX_PENDING_PRIORITY_CONTROL = 16
const MAX_PENDING_REMOTE_CANDIDATES = 64
const MAX_PENDING_LOCAL_CANDIDATES = 64
const REQUEST_TIMEOUT_MS = 15_000
const RECONNECT_GRACE_MS = 10_000
const MAX_ICE_RESTART_ATTEMPTS = 6
const SIGNALING_COMPLETE_RETRY_MS = 1_000
const MAX_SIGNALING_COMPLETE_ATTEMPTS = 30
const NON_RETRYABLE_SIGNALING_ERRORS = new Set([
  'bad_message',
  'bad_json',
  'device_in_use',
  'invalid_pairing',
  'origin_rejected',
  'pairing_expired',
  'payload_too_large',
  'peer_in_use',
  'stale_session',
  'protocol_mismatch',
])

let messageCounter = 0
let attemptCounter = 0

function nextMessageId(): string {
  return `msg_${Date.now().toString(36)}_${(messageCounter++).toString(36)}`
}

function nextAttemptId(): string {
  const randomId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replaceAll('-', '')
    : [Date.now().toString(36), (attemptCounter++).toString(36)].join('_')
  return ['peer', randomId].join('_')
}

function errorFromUnknown(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback)
}

function isRole(value: Role, expected: Role): boolean {
  return value === expected
}

export function createWebRtcTransport(role: Role = 'client'): SweetSpotTransport {
  let currentState: DirectConnectionState = 'idle'
  let pairing: PairingCredentials | null = null
  let sessionId: string | null = null
  let peer: RTCPeerConnection | null = null
  let control: RTCDataChannel | null = null
  let capture: RTCDataChannel | null = null
  let signaling: SignalingClient | null = null
  let disposed = false
  let remoteCapabilities: TransportCapabilities | null = null
  let localReady = false
  let remoteReady = false
  let remoteDescriptionSet = false
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let statsTimer: ReturnType<typeof setInterval> | null = null
  let signalingRetryTimer: ReturnType<typeof setTimeout> | null = null
  let signalingCompleteRetryTimer: ReturnType<typeof setTimeout> | null = null
  let signalingCompleteAttempts = 0
  let signalingCompleteConnectInFlight = false
  let reconnectCount = 0
  let iceRestartAttempts = 0
  let pendingControl: Envelope[] = []
  let pendingPriorityControl: Envelope[] = []
  let offerInFlight = false
  let localOfferSignaled = false
  let signalingCompleteAcknowledged = false
  let peerAttemptId: string | null = null

  const messageHandlers = new Set<(env: Envelope) => void>()
  const stateHandlers = new Set<(state: DirectConnectionState) => void>()
  const diagnosticsHandlers = new Set<(diagnostics: TransportDiagnostics) => void>()
  const pendingRequests = new Map<string, {
    cleanup: () => void
    reject: (reason: SweetSpotRequestError) => void
  }>()
  const pendingRemoteCandidates: RTCIceCandidateInit[] = []
  const pendingLocalCandidates: RTCIceCandidateInit[] = []
  const seenMessageIds = new Set<string>()
  const captureQueue = new BoundedCaptureQueue({
    maxFrames: 8,
    highWaterBytes: CAPTURE_HIGH_WATER_BYTES,
    send: (frame) => {
      const channel = capture
      if (!channel || channel.readyState !== 'open') throw new Error('The direct capture channel is not open.')
      try {
        channel.send(frame)
      } catch (error: unknown) {
        replacePeerAfterChannelLoss()
        throw error
      }
      diagnostics = {
        ...diagnostics,
        bytesSent: diagnostics.bytesSent + frame.byteLength,
        captureBufferedBytes: channel.bufferedAmount,
        lastPeerTrafficAt: Date.now(),
      }
      emitDiagnostics()
      return channel.bufferedAmount
    },
  })
  let diagnostics: TransportDiagnostics = {
    state: 'idle',
    sessionId: null,
    iceConnectionState: null,
    iceGatheringState: null,
    peerConnectionState: null,
    selectedCandidateType: null,
    selectedCandidateProtocol: null,
    rttMs: null,
    bytesSent: 0,
    bytesReceived: 0,
    captureBufferedBytes: 0,
    reconnectCount: 0,
    signalingRoundTripMs: null,
    lastControlMessageAt: null,
    lastPeerTrafficAt: null,
    lastError: null,
  }

  function emitDiagnostics(): void {
    diagnostics = {
      ...diagnostics,
      state: currentState,
      sessionId,
      captureBufferedBytes: capture?.bufferedAmount ?? 0,
      reconnectCount,
    }
    for (const handler of diagnosticsHandlers) handler(diagnostics)
  }

  function setState(next: DirectConnectionState): void {
    if (currentState === next) {
      emitDiagnostics()
      return
    }
    currentState = next
    emitDiagnostics()
    for (const handler of stateHandlers) handler(next)
  }

  function setError(error: TransportError | null): void {
    diagnostics = { ...diagnostics, lastError: error }
    emitDiagnostics()
  }

  function makeTransportError(kind: TransportError['kind'], code: string, message: string, retryable: boolean): TransportError {
    return { kind, code, message, retryable }
  }

  function rejectPendingRequests(kind: 'connection' | 'disposed'): void {
    for (const pending of pendingRequests.values()) pending.reject(new SweetSpotRequestError(kind, 'transport'))
    pendingRequests.clear()
  }

  function isCurrentSession(candidateSessionId: string): boolean {
    return sessionId !== null && candidateSessionId === sessionId
  }

  function closePeer(): void {
    if (restartTimer !== null) clearTimeout(restartTimer)
    restartTimer = null
    if (statsTimer !== null) clearInterval(statsTimer)
    statsTimer = null
    if (signalingRetryTimer !== null) clearTimeout(signalingRetryTimer)
    signalingRetryTimer = null
    if (signalingCompleteRetryTimer !== null) clearTimeout(signalingCompleteRetryTimer)
    signalingCompleteRetryTimer = null
    signalingCompleteAttempts = 0
    signalingCompleteConnectInFlight = false
    const currentControl = control
    const currentCapture = capture
    captureQueue.reset()
    control = null
    capture = null
    if (currentControl) {
      currentControl.onmessage = null
      currentControl.onopen = null
      currentControl.onclose = null
      currentControl.onerror = null
      currentControl.onbufferedamountlow = null
    }
    if (currentCapture) {
      currentCapture.onmessage = null
      currentCapture.onopen = null
      currentCapture.onclose = null
      currentCapture.onerror = null
      currentCapture.onbufferedamountlow = null
    }
    currentControl?.close()
    currentCapture?.close()
    const currentPeer = peer
    peer = null
    offerInFlight = false
    if (currentPeer) {
      currentPeer.onicecandidate = null
      currentPeer.ondatachannel = null
      currentPeer.oniceconnectionstatechange = null
      currentPeer.onconnectionstatechange = null
      currentPeer.onicegatheringstatechange = null
      currentPeer.close()
    }
    remoteCapabilities = null
    localReady = false
    remoteReady = false
    remoteDescriptionSet = false
    signalingCompleteAcknowledged = false
    peerAttemptId = null
    localOfferSignaled = false
    pendingLocalCandidates.length = 0
    pendingRemoteCandidates.length = 0
  }

  function closeSignaling(): void {
    signaling?.close()
    signaling = null
  }

  function teardown(): void {
    closePeer()
    closeSignaling()
    pendingControl = []
    pendingPriorityControl = []
  }

  function sendSignaling(message: SignalingMessage): boolean {
    return signaling?.send(message) ?? false
  }

  function reconnectSignaling(): void {
    const current = signaling
    const nextPairing = pairing
    const generation = sessionId
    if (!current || !nextPairing || !generation) return
    current.suspend()
    void current.connect(nextPairing, generation).catch(() => undefined)
  }

  function updatePeerDiagnostics(currentPeer: RTCPeerConnection): void {
    if (peer !== currentPeer) return
    diagnostics = {
      ...diagnostics,
      iceConnectionState: currentPeer.iceConnectionState,
      iceGatheringState: currentPeer.iceGatheringState,
      peerConnectionState: currentPeer.connectionState,
    }
    emitDiagnostics()
  }

  async function refreshPeerStats(currentPeer: RTCPeerConnection): Promise<void> {
    if (peer !== currentPeer || disposed) return
    try {
      const snapshot = await readPeerStats(currentPeer)
      if (peer !== currentPeer) return
      if (!snapshot) return
      diagnostics = {
        ...diagnostics,
        selectedCandidateType: snapshot.selectedCandidateType,
        selectedCandidateProtocol: snapshot.selectedCandidateProtocol,
        rttMs: snapshot.rttMs,
        bytesSent: snapshot.bytesSent ?? diagnostics.bytesSent,
        bytesReceived: snapshot.bytesReceived ?? diagnostics.bytesReceived,
      }
      emitDiagnostics()
    } catch {
      // Browser stats are diagnostic only and must not affect the peer state.
    }
  }

  function startPeerStats(currentPeer: RTCPeerConnection): void {
    if (statsTimer !== null) clearInterval(statsTimer)
    statsTimer = setInterval(() => { void refreshPeerStats(currentPeer) }, 5_000)
    void refreshPeerStats(currentPeer)
  }

  function maybeDirect(): void {
    if (!isCurrentSession(sessionId ?? '') || !control || !capture || control.readyState !== 'open'
      || capture.readyState !== 'open' || !remoteCapabilities || !localReady || !remoteReady) return
    setState('direct')
    setError(null)
    iceRestartAttempts = 0
    if (restartTimer !== null) clearTimeout(restartTimer)
    restartTimer = null
    if (!signalingCompleteAcknowledged && signalingCompleteAttempts === 0) sendSignalingComplete()
    flushPendingControl()
  }

  function sendCapabilityMessage(type: 'hello' | 'ready'): void {
    if (!sessionId || !control || control.readyState !== 'open') return
    const value: TransportCapabilityMessage = {
      kind: 'sweetspot.transport',
      type,
      sessionId,
      capabilities: localTransportCapabilities(import.meta.env.NUXT_PUBLIC_BUILD_SHA ?? 'web-local'),
    }
    const text = JSON.stringify(value)
    if (utf8ByteLength(text) > MAX_PAYLOAD_BYTES) {
      setError(makeTransportError('protocol', 'capability_too_large', 'The direct transport handshake is too large.', false))
      setState('failed')
      return
    }
    try {
      control.send(text)
      localReady = true
      emitDiagnostics()
    } catch {
      setError(makeTransportError('p2p', 'control_channel_failed', 'The direct control channel failed.', true))
      setState('reconnecting')
    }
  }

  function handleCapability(value: TransportCapabilityMessage): void {
    if (!isCurrentSession(value.sessionId)) return
    if (value.capabilities.maxCaptureChunkBytes < MAX_CAPTURE_CHUNK_BYTES) {
      setError(makeTransportError('protocol', 'capture_chunk_unsupported', 'The TV cannot receive the required capture chunk size.', false))
      setState('failed')
      return
    }
    remoteCapabilities = value.capabilities
    if (value.type === 'hello') sendCapabilityMessage('ready')
    if (value.type === 'ready') remoteReady = true
    if (value.type === 'hello') remoteReady = true
    maybeDirect()
  }

  function deliver(env: Envelope): void {
    if (!isCurrentSession(env.transportSessionId ?? '')) return
    if (seenMessageIds.has(env.id)) return
    seenMessageIds.add(env.id)
    if (seenMessageIds.size > 512) {
      const first = seenMessageIds.values().next().value
      if (first) seenMessageIds.delete(first)
    }
    diagnostics = {
      ...diagnostics,
      lastControlMessageAt: Date.now(),
      lastPeerTrafficAt: Date.now(),
      bytesReceived: diagnostics.bytesReceived,
    }
    emitDiagnostics()
    for (const handler of messageHandlers) handler(env)
  }

  function onControlMessage(event: MessageEvent<unknown>): void {
    if (typeof event.data !== 'string') {
      setError(makeTransportError('protocol', 'invalid_control', 'The TV sent binary data on the control channel.', false))
      replacePeerAfterChannelLoss()
      return
    }
    diagnostics = { ...diagnostics, bytesReceived: diagnostics.bytesReceived + utf8ByteLength(event.data) }
    const message = parseControlMessage(event.data)
    if (message.kind === 'ignored') return
    if (message.kind === 'capability') {
      handleCapability(message.value)
      return
    }
    if (message.kind === 'envelope') {
      deliver(message.value)
      return
    }
    setError(makeTransportError('protocol', message.code, message.message, false))
  }

  function onCaptureMessage(): void {
    setError(makeTransportError(
      'protocol',
      'unexpected_capture_data',
      'The TV sent unexpected binary data on the capture channel.',
      false,
    ))
    replacePeerAfterChannelLoss()
  }

  function onControlOpen(): void {
    if (control) {
      control.bufferedAmountLowThreshold = CONTROL_LOW_WATER_BYTES
      sendCapabilityMessage('hello')
      maybeDirect()
    }
  }

  function onControlClose(): void {
    replacePeerAfterChannelLoss()
  }

  function replacePeerAfterChannelLoss(): void {
    const hadPeer = peer !== null
    closePeer()
    if (!hadPeer || disposed) return
    if (currentState === 'direct') setState('reconnecting')
    scheduleIceRestart()
  }

  function onControlError(): void {
    setError(makeTransportError('p2p', 'control_channel_failed', 'The direct control channel failed.', true))
    replacePeerAfterChannelLoss()
  }

  function onControlLow(): void {
    flushPendingControl()
  }

  function onCaptureOpen(): void {
    maybeDirect()
  }

  function onCaptureClose(): void {
    captureQueue.reset(new Error('The direct capture channel closed during upload.'))
    replacePeerAfterChannelLoss()
  }

  function onCaptureError(): void {
    setError(makeTransportError('p2p', 'capture_channel_failed', 'The direct capture channel failed.', true))
    replacePeerAfterChannelLoss()
  }

  function onCaptureLow(): void {
    if (capture) captureQueue.updateBufferedAmount(capture.bufferedAmount)
  }

  function attachControl(channel: RTCDataChannel, owner: RTCPeerConnection): void {
    control = channel
    bindControlChannel(channel, () => peer === owner && control === channel, {
      onMessage: onControlMessage,
      onOpen: onControlOpen,
      onClose: onControlClose,
      onError: onControlError,
      onBufferedAmountLow: onControlLow,
    })
  }

  function attachCapture(channel: RTCDataChannel, owner: RTCPeerConnection): void {
    capture = channel
    captureQueue.updateBufferedAmount(channel.bufferedAmount)
    bindCaptureChannel(channel, CAPTURE_LOW_WATER_BYTES, () => peer === owner && capture === channel, {
      onMessage: onCaptureMessage,
      onOpen: onCaptureOpen,
      onClose: onCaptureClose,
      onError: onCaptureError,
      onBufferedAmountLow: onCaptureLow,
    })
  }

  function onDataChannel(channel: RTCDataChannel, owner: RTCPeerConnection): void {
    if (peer !== owner) {
      channel.close()
      return
    }
    if (channel.label === CONTROL_CHANNEL) attachControl(channel, owner)
    else if (channel.label === CAPTURE_CHANNEL) attachCapture(channel, owner)
    else channel.close()
  }

  async function applyRemoteCandidates(owner: RTCPeerConnection): Promise<void> {
    if (peer !== owner || !remoteDescriptionSet) return
    while (pendingRemoteCandidates.length > 0) {
      const candidate = pendingRemoteCandidates.shift()
      if (!candidate || peer !== owner) return
      await owner.addIceCandidate(candidate)
    }
  }

  async function createOffer(iceRestart: boolean): Promise<boolean> {
    const currentPeer = peer
    const generation = sessionId
    if (!currentPeer || !generation || !signaling || !isRole(role, 'client') || offerInFlight) return false
    if (!iceRestart && localOfferSignaled) return true
    offerInFlight = true
    localOfferSignaled = false
    pendingLocalCandidates.length = 0
    setState(iceRestart ? 'reconnecting' : 'connecting')
    try {
      const offer = await currentPeer.createOffer({ iceRestart })
      if (offer.type !== 'offer' || !offer.sdp) throw new Error('The browser did not create an SDP offer.')
      await currentPeer.setLocalDescription(offer)
      const attemptId = peerAttemptId
      if (peer !== currentPeer || sessionId !== generation || !attemptId) return false
      if (!sendSignaling({
        v: 1,
        type: 'signal.offer',
        generation,
        attemptId,
        description: { type: 'offer', sdp: offer.sdp },
      })) throw new Error('The signaling connection is unavailable.')
      localOfferSignaled = true
      const candidates = pendingLocalCandidates.splice(0)
      for (const candidate of candidates) {
        if (!sendSignaling({
          v: 1,
          type: 'signal.ice',
          generation,
          attemptId,
          candidate: {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
          },
        })) throw new Error('The signaling connection is unavailable while sending ICE candidates.')
      }
      return true
    } catch (error: unknown) {
      if (peer === currentPeer && sessionId === generation) {
        setError(makeTransportError('p2p', 'offer_failed', errorFromUnknown(error, 'The browser could not create a direct connection.').message, true))
        setState('reconnecting')
        scheduleIceRestart()
      }
      return false
    } finally {
      if (peer === currentPeer && sessionId === generation) offerInFlight = false
    }
  }

  function scheduleIceRestart(): void {
    if (restartTimer !== null || disposed || !pairing || !sessionId) return
    if (iceRestartAttempts >= MAX_ICE_RESTART_ATTEMPTS) {
      setError(makeTransportError(
        'p2p',
        'direct_path_unavailable',
        'TV and phone could not form a direct connection. Check the home network, Guest Wi-Fi, client isolation, and VPN settings, then retry.',
        false,
      ))
      signaling?.suspend()
      setState('failed')
      return
    }
    if (currentState === 'failed' && diagnostics.lastError?.retryable !== false) setState('reconnecting')
    restartTimer = setTimeout(() => {
      restartTimer = null
      iceRestartAttempts++
      reconnectCount++
      emitDiagnostics()
      void reopenSignalingAndRestart()
    }, RECONNECT_GRACE_MS)
  }

  async function reopenSignalingAndRestart(): Promise<void> {
    if (disposed || !pairing || !sessionId) return
    const current = signaling
    const currentPeer = peer
    const generation = sessionId
    try {
      if (current) await current.connect(pairing, generation)
      else await openSignaling()
      if (disposed || sessionId !== generation) return
      if (!peer) createPeer()
      const activePeer = peer
      if (!activePeer) throw new Error('The browser could not recreate the direct peer.')
      await createOffer(currentPeer !== null)
      if (peer === activePeer && sessionId === generation && currentState !== 'direct'
        && diagnostics.lastError?.retryable !== false) scheduleIceRestart()
    } catch (error: unknown) {
      setError(makeTransportError(
        'signaling',
        'signaling_unavailable',
        errorFromUnknown(error, 'Signaling service is unavailable.').message,
        true,
      ))
      if (sessionId === generation && !disposed) scheduleIceRestart()
    }
  }

  function handlePeerState(currentPeer: RTCPeerConnection): void {
    updatePeerDiagnostics(currentPeer)
    if (peer !== currentPeer || disposed) return
    if (currentPeer.connectionState === 'connected' && control?.readyState === 'open' && capture?.readyState === 'open') {
      maybeDirect()
      return
    }
    if (currentPeer.connectionState === 'disconnected' || currentPeer.iceConnectionState === 'disconnected') {
      setState('reconnecting')
      scheduleIceRestart()
    } else if (currentPeer.connectionState === 'failed' || currentPeer.iceConnectionState === 'failed') {
      setState('reconnecting')
      scheduleIceRestart()
    } else if (currentPeer.connectionState === 'connecting' || currentPeer.iceConnectionState === 'checking') {
      setState('connecting')
    }
  }

  function createPeer(): void {
    if (peer || disposed || role !== 'client') return
    const next = new RTCPeerConnection({ iceServers: [] })
    const attemptId = nextAttemptId()
    peer = next
    peerAttemptId = attemptId
    next.onicecandidate = (event) => {
      if (peer !== next) return
      const candidate = event.candidate
      if (!candidate || !candidate.candidate || !sessionId) return
      const sdpMLineIndex = candidate.sdpMLineIndex ?? 0
      if (!Number.isInteger(sdpMLineIndex) || sdpMLineIndex < 0 || sdpMLineIndex > 32) return
      const candidateValue = {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex,
      }
      if (!localOfferSignaled) {
        if (pendingLocalCandidates.length >= MAX_PENDING_LOCAL_CANDIDATES) {
          setError(makeTransportError('protocol', 'too_many_ice_candidates', 'The direct connection sent too many ICE candidates.', false))
          setState('failed')
          return
        }
        pendingLocalCandidates.push(candidateValue)
        return
      }
      if (!sendSignaling({
        v: 1,
        type: 'signal.ice',
        generation: sessionId,
        attemptId,
        candidate: candidateValue,
      })) {
        setError(makeTransportError('signaling', 'signaling_unavailable', 'The signaling service is unavailable while connecting.', true))
        if (currentState !== 'direct') {
          setState('reconnecting')
          scheduleIceRestart()
        }
      }
    }
    next.ondatachannel = (event) => onDataChannel(event.channel, next)
    next.oniceconnectionstatechange = () => handlePeerState(next)
    next.onconnectionstatechange = () => handlePeerState(next)
    next.onicegatheringstatechange = () => updatePeerDiagnostics(next)
    attachControl(next.createDataChannel(CONTROL_CHANNEL, { ordered: true }), next)
    attachCapture(next.createDataChannel(CAPTURE_CHANNEL, { ordered: true }), next)
    startPeerStats(next)
  }

  async function handleSignal(message: SignalingMessage): Promise<void> {
    try {
      if (message.type === 'signal.ready') {
        if (message.peerOnline && role === 'client') {
          createPeer()
          await createOffer(false)
        } else if (!message.peerOnline) {
          setState('pairing')
        }
        return
      }
      if (message.type === 'signal.peer') {
        if (message.role === 'device' && message.online && role === 'client') {
          createPeer()
          await createOffer(false)
        }
        return
      }
      if (message.type === 'signal.error') {
        const retryable = !NON_RETRYABLE_SIGNALING_ERRORS.has(message.code)
        setError(makeTransportError('signaling', message.code, message.message, retryable))
        if (currentState !== 'direct') {
          if (!retryable) {
            if (signalingRetryTimer !== null) clearTimeout(signalingRetryTimer)
            signalingRetryTimer = null
            signaling?.suspend()
            setState('failed')
          } else {
            const hadPeer = peer !== null
            closePeer()
            if (hadPeer) setState('reconnecting')
            reconnectSignaling()
          }
        }
        return
      }
      if (!sessionId || message.generation !== sessionId) return
      if (message.type === 'signal.complete.ack') {
        if (message.attemptId !== peerAttemptId) return
        signalingCompleteAcknowledged = true
        if (signalingCompleteRetryTimer !== null) clearTimeout(signalingCompleteRetryTimer)
        signalingCompleteRetryTimer = null
        signaling?.suspend()
        return
      }
      if (message.type === 'signal.answer') {
        if (message.attemptId !== peerAttemptId || !peer || message.description.type !== 'answer') return
        const currentPeer = peer
        await currentPeer.setRemoteDescription(message.description)
        if (peer !== currentPeer || sessionId !== message.generation) return
        remoteDescriptionSet = true
        await applyRemoteCandidates(currentPeer)
        return
      }
      if (message.type === 'signal.ice') {
        if (message.attemptId !== peerAttemptId) return
        const currentPeer = peer
        if (!currentPeer) return
        if (!remoteDescriptionSet) {
          if (pendingRemoteCandidates.length >= MAX_PENDING_REMOTE_CANDIDATES) {
            setError(makeTransportError('protocol', 'too_many_ice_candidates', 'The direct connection sent too many ICE candidates.', false))
            setState('failed')
            return
          }
          pendingRemoteCandidates.push(message.candidate)
        } else {
          await currentPeer.addIceCandidate(message.candidate)
        }
        return
      }
    } catch (error: unknown) {
      if (disposed) return
      setError(makeTransportError(
        'p2p',
        'signaling_message_failed',
        errorFromUnknown(error, 'The direct connection could not apply the signaling message.').message,
        true,
      ))
      if (peer) replacePeerAfterChannelLoss()
      else {
        setState('reconnecting')
        scheduleIceRestart()
      }
    }
  }

  function handleSignalingClose(reason: string): void {
    if (disposed) return
    const current = signaling
    if (currentState === 'direct' || currentState === 'reconnecting') return
    if (diagnostics.lastError?.retryable === false) {
      setState('failed')
      return
    }
    setError(makeTransportError('signaling', 'signaling_unavailable', reason, true))
    setState('signaling')
    if (signalingRetryTimer === null && current && pairing && sessionId) {
      signalingRetryTimer = setTimeout(() => {
        signalingRetryTimer = null
        if (!disposed && signaling === current && pairing && sessionId) {
          void current.connect(pairing, sessionId).catch(() => undefined)
        }
      }, 1_000)
    }
  }

  async function openSignaling(): Promise<void> {
    if (!pairing || !sessionId || disposed) return
    setState('signaling')
    const generation = sessionId
    let next: SignalingClient | null = null
    next = createSignalingClient(role, {
      onMessage: (message) => {
        if (signaling !== next || !isSignalingMessage(message)) return
        void handleSignal(message)
      },
      onClose: (reason) => {
        if (signaling === next) handleSignalingClose(reason)
      },
    })
    signaling = next
    const generationStartedAt = Date.now()
    try {
      await next.connect(pairing, generation)
      if (signaling === next && signalingRetryTimer !== null) {
        clearTimeout(signalingRetryTimer)
        signalingRetryTimer = null
      }
      diagnostics = { ...diagnostics, signalingRoundTripMs: Date.now() - generationStartedAt }
      emitDiagnostics()
    } catch (error: unknown) {
      if (signaling !== next || disposed) return
      setError(makeTransportError('signaling', 'signaling_unavailable', errorFromUnknown(error, 'Signaling service is unavailable.').message, true))
      setState('failed')
    }
  }

  function sendControl(env: Envelope): boolean {
    if (currentState !== 'direct' || !control || control.readyState !== 'open') return false
    try {
      const text = JSON.stringify(env)
      const bytes = utf8ByteLength(text)
      if (bytes > MAX_PAYLOAD_BYTES || control.bufferedAmount + bytes > CONTROL_HIGH_WATER_BYTES) return false
      control.send(text)
      diagnostics = { ...diagnostics, bytesSent: diagnostics.bytesSent + bytes, lastPeerTrafficAt: Date.now() }
      emitDiagnostics()
      return true
    } catch {
      setError(makeTransportError('p2p', 'control_channel_failed', 'The direct control channel failed.', true))
      replacePeerAfterChannelLoss()
      return false
    }
  }

  function flushPendingControl(): void {
    const now = Date.now()
    const priority = pendingPriorityControl
    pendingPriorityControl = []
    for (let index = 0; index < priority.length; index += 1) {
      const env = priority[index]
      if (!env) continue
      if (env.expiresAt !== undefined && env.expiresAt <= now) continue
      if (!sendControl(env)) {
        pendingPriorityControl.push(...priority.slice(index))
        break
      }
    }
    if (pendingPriorityControl.length > 0) {
      return
    }
    const pending = pendingControl
    pendingControl = []
    for (let index = 0; index < pending.length; index += 1) {
      const env = pending[index]
      if (!env) continue
      if (env.expiresAt !== undefined && env.expiresAt <= now) continue
      if (!sendControl(env)) {
        pendingControl.push(...pending.slice(index))
        break
      }
    }
    if (pendingPriorityControl.length > MAX_PENDING_PRIORITY_CONTROL) {
      pendingPriorityControl = pendingPriorityControl.slice(-MAX_PENDING_PRIORITY_CONTROL)
    }
    if (pendingControl.length > MAX_PENDING_CONTROL) pendingControl = pendingControl.slice(-MAX_PENDING_CONTROL)
  }

  function dispatchOrQueue(env: Envelope): void {
    if (serializedUtf8ByteLength(env) > MAX_PAYLOAD_BYTES) {
      setError(makeTransportError('protocol', 'control_too_large', 'The direct control message exceeds the size limit.', false))
      return
    }
    if (disposed) return
    if (sendControl(env)) return
    if (isPriorityControl(env)) {
      pendingPriorityControl = [...pendingPriorityControl, env].slice(-MAX_PENDING_PRIORITY_CONTROL)
    } else {
      pendingControl = [...pendingControl, env].slice(-MAX_PENDING_CONTROL)
    }
  }

  function isPriorityControl(env: Envelope): boolean {
    return env.type === 'calibration.job.cancel'
      || env.type === 'calibration.job.discard'
      || env.type === 'state.get'
  }

  function sendSignalingComplete(): void {
    if (signalingCompleteAcknowledged || disposed || !sessionId || !peerAttemptId) return
    if (signalingCompleteAttempts >= MAX_SIGNALING_COMPLETE_ATTEMPTS) {
      signaling?.suspend()
      return
    }
    signalingCompleteAttempts++
    const sent = sendSignaling({
      v: 1,
      type: 'signal.complete',
      generation: sessionId,
      attemptId: peerAttemptId,
    })
    if (!sent) {
      reconnectSignalingForCompletion()
    } else {
      scheduleSignalingCompleteRetry()
    }
  }

  function reconnectSignalingForCompletion(): void {
    if (signalingCompleteConnectInFlight || signalingCompleteAcknowledged || disposed
      || !signaling || !pairing || !sessionId) {
      scheduleSignalingCompleteRetry()
      return
    }
    const current = signaling
    const generation = sessionId
    const attemptId = peerAttemptId
    signalingCompleteConnectInFlight = true
    void current.connect(pairing, generation)
      .then(() => {
        if (!disposed && signaling === current && sessionId === generation && peerAttemptId === attemptId) {
          sendSignalingComplete()
        }
      })
      .catch(() => {
        scheduleSignalingCompleteRetry()
      })
      .finally(() => {
        signalingCompleteConnectInFlight = false
      })
  }

  function scheduleSignalingCompleteRetry(): void {
    if (signalingCompleteRetryTimer !== null || signalingCompleteAcknowledged || disposed) return
    if (signalingCompleteAttempts >= MAX_SIGNALING_COMPLETE_ATTEMPTS) {
      signalingCompleteRetryTimer = setTimeout(() => {
        signalingCompleteRetryTimer = null
        if (!signalingCompleteAcknowledged) signaling?.suspend()
      }, SIGNALING_COMPLETE_RETRY_MS)
      return
    }
    signalingCompleteRetryTimer = setTimeout(() => {
      signalingCompleteRetryTimer = null
      sendSignalingComplete()
    }, SIGNALING_COMPLETE_RETRY_MS)
  }

  function outgoingProtocolError(type: string, payload: unknown): string | null {
    if (!isClientToDevice(type)) return 'The browser cannot send this message to the TV.'
    return validatePayload(type, payload)
  }

  function makeEnvelope(type: string, payload: unknown, replyTo?: string): Envelope {
    const timestamp = Date.now()
    return {
      v: PROTOCOL_VERSION,
      id: nextMessageId(),
      type,
      ts: timestamp,
      payload,
      transportSessionId: sessionId ?? undefined,
      expiresAt: timestamp + 30_000,
      ...(replyTo ? { replyTo } : {}),
    }
  }

  function send(type: string, payload: unknown = {}, replyTo?: string): string {
    const env = makeEnvelope(type, payload, replyTo)
    const validationError = outgoingProtocolError(type, payload)
    if (validationError) {
      setError(makeTransportError('protocol', 'invalid_outgoing_message', validationError, false))
      return env.id
    }
    dispatchOrQueue(env)
    return env.id
  }

  function request<T = unknown>(
    type: string,
    payload: unknown = {},
    options: TransportRequestOptions = {},
  ): Promise<Envelope<T>> {
    return new Promise((resolve, reject) => {
      if (disposed) {
        reject(new SweetSpotRequestError('disposed', type))
        return
      }
      if (options.signal?.aborted) {
        reject(new SweetSpotRequestError('aborted', type))
        return
      }
      const env = makeEnvelope(type, payload)
      const validationError = outgoingProtocolError(type, payload)
      if (validationError) {
        setError(makeTransportError('protocol', 'invalid_outgoing_message', validationError, false))
        reject(new SweetSpotRequestError('protocol', type))
        return
      }
      if (serializedUtf8ByteLength(env) > MAX_PAYLOAD_BYTES) {
        reject(new SweetSpotRequestError('protocol', type))
        return
      }
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
      const off = () => messageHandlers.delete(handler)
      const removeQueued = () => {
        pendingControl = pendingControl.filter((candidate) => candidate.id !== env.id)
        pendingPriorityControl = pendingPriorityControl.filter((candidate) => candidate.id !== env.id)
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
      messageHandlers.add(handler)
      timeout = setTimeout(() => rejectRequest(new SweetSpotRequestError('timeout', type)), timeoutMs)
      if (options.signal) {
        abortListener = () => rejectRequest(new SweetSpotRequestError('aborted', type))
        options.signal.addEventListener('abort', abortListener, { once: true })
      }
      pendingRequests.set(env.id, { cleanup, reject: rejectRequest })
      dispatchOrQueue(env)
    })
  }

  function sendCaptureFrame(frame: ArrayBuffer, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (frame.byteLength > MAX_CAPTURE_FRAME_BYTES) {
      return Promise.reject(new Error('The capture chunk exceeds the direct transport limit.'))
    }
    if (currentState !== 'direct' || !capture || capture.readyState !== 'open') {
      return Promise.reject(new Error('The direct capture channel is not open.'))
    }
    return captureQueue.enqueue(frame, options)
  }

  return {
    get state() { return currentState },
    connect(nextPairing) {
      if (disposed) return
      rejectPendingRequests('connection')
      teardown()
      pairing = nextPairing
      sessionId = sessionIdForPairing(nextPairing.rendezvousId)
      diagnostics = { ...diagnostics, lastError: null }
      iceRestartAttempts = 0
      setState('pairing')
      void openSignaling()
    },
    disconnect() {
      if (disposed) return
      disposed = true
      teardown()
      rejectPendingRequests('disposed')
      setState('closed')
    },
    send,
    request,
    sendCaptureFrame,
    onMessage(handler) {
      messageHandlers.add(handler)
      return () => messageHandlers.delete(handler)
    },
    onStateChange(handler) {
      stateHandlers.add(handler)
      return () => stateHandlers.delete(handler)
    },
    onDiagnostics(handler) {
      diagnosticsHandlers.add(handler)
      handler(diagnostics)
      return () => diagnosticsHandlers.delete(handler)
    },
    diagnostics() {
      return { ...diagnostics }
    },
  }
}
