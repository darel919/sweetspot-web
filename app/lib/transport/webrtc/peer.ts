import {
  isTransportCapabilityMessage,
  localTransportCapabilities,
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
  PROTOCOL_VERSION,
  isDeviceToClient,
  isEnvelope,
  validatePayload,
  type Envelope,
  type Role,
} from '#shared/types/protocol'
import { SweetSpotRequestError } from '../errors'
import { sessionIdForPairing } from '../../pairing/session'
import { createSignalingClient, type SignalingClient } from '../signaling/client'
import { BoundedCaptureQueue } from './backpressure'
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
const MAX_PENDING_CONTROL = 128
const REQUEST_TIMEOUT_MS = 15_000
const RECONNECT_GRACE_MS = 10_000

let messageCounter = 0

function nextMessageId(): string {
  return `msg_${Date.now().toString(36)}_${(messageCounter++).toString(36)}`
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
  let reconnectCount = 0
  let pendingControl: Envelope[] = []
  let offerInFlight = false
  let signalingCompleteSent = false

  const messageHandlers = new Set<(env: Envelope) => void>()
  const stateHandlers = new Set<(state: DirectConnectionState) => void>()
  const diagnosticsHandlers = new Set<(diagnostics: TransportDiagnostics) => void>()
  const pendingRequests = new Map<string, {
    cleanup: () => void
    reject: (reason: SweetSpotRequestError) => void
  }>()
  const pendingRemoteCandidates: RTCIceCandidateInit[] = []
  const seenMessageIds = new Set<string>()
  const captureQueue = new BoundedCaptureQueue({
    maxFrames: 8,
    highWaterBytes: CAPTURE_HIGH_WATER_BYTES,
    send: (frame) => {
      const channel = capture
      if (!channel || channel.readyState !== 'open') throw new Error('The direct capture channel is not open.')
      channel.send(frame)
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
    currentPeer?.close()
    remoteCapabilities = null
    localReady = false
    remoteReady = false
    remoteDescriptionSet = false
    signalingCompleteSent = false
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
  }

  function sendSignaling(message: SignalingMessage): boolean {
    return signaling?.send(message) ?? false
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
      const reports = await currentPeer.getStats()
      if (peer !== currentPeer) return
      let selectedPair: RTCIceCandidatePairStats | null = null
      reports.forEach((report) => {
        if (report.type !== 'candidate-pair') return
        const pair = report as RTCIceCandidatePairStats & { selected?: boolean }
        if (pair.selected === true || (pair.nominated === true && pair.state === 'succeeded')) selectedPair = pair
      })
      if (!selectedPair) return
      const localCandidate = reports.get(selectedPair.localCandidateId) as RTCIceCandidateStats | undefined
      const remoteCandidate = reports.get(selectedPair.remoteCandidateId) as RTCIceCandidateStats | undefined
      diagnostics = {
        ...diagnostics,
        selectedCandidateType: localCandidate?.candidateType ?? remoteCandidate?.candidateType ?? null,
        selectedCandidateProtocol: localCandidate?.protocol ?? remoteCandidate?.protocol ?? null,
        rttMs: typeof selectedPair.currentRoundTripTime === 'number'
          ? selectedPair.currentRoundTripTime * 1_000
          : null,
        bytesSent: typeof selectedPair.bytesSent === 'number' ? selectedPair.bytesSent : diagnostics.bytesSent,
        bytesReceived: typeof selectedPair.bytesReceived === 'number' ? selectedPair.bytesReceived : diagnostics.bytesReceived,
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
    if (restartTimer !== null) clearTimeout(restartTimer)
    restartTimer = null
    if (!signalingCompleteSent && sessionId) {
      signalingCompleteSent = sendSignaling({ v: 1, type: 'signal.complete', generation: sessionId })
      if (signalingCompleteSent) signaling?.suspend()
    }
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
    control.send(JSON.stringify(value))
    localReady = true
    emitDiagnostics()
  }

  function handleCapability(value: TransportCapabilityMessage): void {
    if (!isCurrentSession(value.sessionId)) return
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
    if (typeof event.data !== 'string') return
    diagnostics = { ...diagnostics, bytesReceived: diagnostics.bytesReceived + event.data.length }
    let value: unknown
    try {
      value = JSON.parse(event.data)
    } catch {
      setError(makeTransportError('protocol', 'invalid_control', 'The TV sent invalid control data.', false))
      return
    }
    if (isTransportCapabilityMessage(value)) {
      handleCapability(value)
      return
    }
    if (isEnvelope(value)) {
      if (!isDeviceToClient(value.type)) {
        setError(makeTransportError('protocol', 'unexpected_message', 'The TV sent an unexpected control message.', false))
        return
      }
      const payloadError = validatePayload(value.type, value.payload)
      if (payloadError) {
        setError(makeTransportError('protocol', 'invalid_payload', 'The TV sent invalid control payload.', false))
        return
      }
      deliver(value)
    } else {
      setError(makeTransportError('protocol', 'invalid_envelope', 'The TV sent an invalid control envelope.', false))
    }
  }

  function onCaptureMessage(event: MessageEvent<unknown>): void {
    if (event.data instanceof ArrayBuffer) {
      diagnostics = { ...diagnostics, bytesReceived: diagnostics.bytesReceived + event.data.byteLength }
      emitDiagnostics()
    }
  }

  function onControlOpen(): void {
    if (control) {
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
  }

  function onCaptureLow(): void {
    if (capture) captureQueue.updateBufferedAmount(capture.bufferedAmount)
  }

  function configureControl(channel: RTCDataChannel, owner: RTCPeerConnection): void {
    control = channel
    channel.binaryType = 'arraybuffer'
    channel.onmessage = (event) => { if (control === channel) onControlMessage(event) }
    channel.onopen = () => { if (control === channel) onControlOpen() }
    channel.onclose = () => { if (control === channel) onControlClose() }
    channel.onerror = () => { if (control === channel) onControlError() }
    if (peer !== owner) channel.close()
  }

  function configureCapture(channel: RTCDataChannel, owner: RTCPeerConnection): void {
    capture = channel
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = CAPTURE_LOW_WATER_BYTES
    captureQueue.updateBufferedAmount(channel.bufferedAmount)
    channel.onmessage = (event) => { if (capture === channel) onCaptureMessage(event) }
    channel.onopen = () => { if (capture === channel) onCaptureOpen() }
    channel.onclose = () => { if (capture === channel) onCaptureClose() }
    channel.onerror = () => { if (capture === channel) onCaptureError() }
    channel.onbufferedamountlow = () => { if (capture === channel) onCaptureLow() }
    if (peer !== owner) channel.close()
  }

  function onDataChannel(channel: RTCDataChannel, owner: RTCPeerConnection): void {
    if (peer !== owner) {
      channel.close()
      return
    }
    if (channel.label === CONTROL_CHANNEL) configureControl(channel, owner)
    else if (channel.label === CAPTURE_CHANNEL) configureCapture(channel, owner)
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
    offerInFlight = true
    setState(iceRestart ? 'reconnecting' : 'connecting')
    try {
      const offer = await currentPeer.createOffer({ iceRestart })
      if (offer.type !== 'offer' || !offer.sdp) throw new Error('The browser did not create an SDP offer.')
      await currentPeer.setLocalDescription(offer)
      if (peer !== currentPeer || sessionId !== generation) return false
      if (!sendSignaling({
        v: 1,
        type: 'signal.offer',
        generation,
        description: { type: 'offer', sdp: offer.sdp },
      })) throw new Error('The signaling connection is unavailable.')
      return true
    } catch (error: unknown) {
      if (peer === currentPeer && sessionId === generation) {
        setError(makeTransportError('p2p', 'offer_failed', errorFromUnknown(error, 'The browser could not create a direct connection.').message, true))
        setState('failed')
      }
      return false
    } finally {
      offerInFlight = false
    }
  }

  function scheduleIceRestart(): void {
    if (restartTimer !== null || disposed || !pairing || !sessionId) return
    if (currentState === 'failed' && diagnostics.lastError?.retryable !== false) setState('reconnecting')
    restartTimer = setTimeout(() => {
      restartTimer = null
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
    peer = next
    next.onicecandidate = (event) => {
      if (peer !== next) return
      const candidate = event.candidate
      if (!candidate || !sessionId) return
      if (candidate.sdpMLineIndex === null) return
      sendSignaling({
        v: 1,
        type: 'signal.ice',
        generation: sessionId,
        candidate: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
        },
      })
    }
    next.ondatachannel = (event) => onDataChannel(event.channel, next)
    next.oniceconnectionstatechange = () => handlePeerState(next)
    next.onconnectionstatechange = () => handlePeerState(next)
    next.onicegatheringstatechange = () => updatePeerDiagnostics(next)
    configureControl(next.createDataChannel(CONTROL_CHANNEL, { ordered: true }), next)
    configureCapture(next.createDataChannel(CAPTURE_CHANNEL, { ordered: true }), next)
    startPeerStats(next)
  }

  async function handleSignal(message: SignalingMessage): Promise<void> {
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
    if (!sessionId || message.generation !== sessionId) return
    if (message.type === 'signal.answer') {
      if (!peer || message.description.type !== 'answer') return
      const currentPeer = peer
      if (!currentPeer) return
      await currentPeer.setRemoteDescription(message.description)
      if (peer !== currentPeer || sessionId !== message.generation) return
      remoteDescriptionSet = true
      await applyRemoteCandidates(currentPeer)
      return
    }
    if (message.type === 'signal.ice') {
      const currentPeer = peer
      if (!currentPeer) return
      if (!remoteDescriptionSet) pendingRemoteCandidates.push(message.candidate)
      else await currentPeer.addIceCandidate(message.candidate)
      return
    }
    if (message.type === 'signal.error') {
      setError(makeTransportError('signaling', message.code, message.message, message.code !== 'pairing_expired'))
      if (currentState !== 'direct') setState('failed')
    }
  }

  function handleSignalingClose(reason: string): void {
    if (disposed) return
    const current = signaling
    if (currentState === 'direct' || currentState === 'reconnecting') return
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
    const next = createSignalingClient(role, {
      onMessage: (message) => {
        if (!isSignalingMessage(message)) return
        void handleSignal(message)
      },
      onClose: handleSignalingClose,
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
      control.send(text)
      diagnostics = { ...diagnostics, bytesSent: diagnostics.bytesSent + text.length, lastPeerTrafficAt: Date.now() }
      emitDiagnostics()
      return true
    } catch {
      setState('reconnecting')
      return false
    }
  }

  function flushPendingControl(): void {
    const pending = pendingControl
    pendingControl = []
    const now = Date.now()
    for (const env of pending) {
      if (env.expiresAt !== undefined && env.expiresAt <= now) continue
      if (!sendControl(env)) {
        pendingControl.push(env)
        break
      }
    }
    if (pendingControl.length > MAX_PENDING_CONTROL) pendingControl = pendingControl.slice(-MAX_PENDING_CONTROL)
  }

  function dispatchOrQueue(env: Envelope): void {
    if (sendControl(env) || disposed) return
    pendingControl = [...pendingControl, env].slice(-MAX_PENDING_CONTROL)
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
    dispatchOrQueue(env)
    return env.id
  }

  function request<T = unknown>(
    type: string,
    payload: unknown = {},
    options: TransportRequestOptions = {},
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
      const off = () => messageHandlers.delete(handler)
      const removeQueued = () => {
        pendingControl = pendingControl.filter((candidate) => candidate.id !== env.id)
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

  function sendCaptureFrame(frame: ArrayBuffer): Promise<void> {
    if (frame.byteLength > MAX_CAPTURE_FRAME_BYTES) {
      return Promise.reject(new Error('The capture chunk exceeds the direct transport limit.'))
    }
    if (currentState !== 'direct' || !capture || capture.readyState !== 'open') {
      return Promise.reject(new Error('The direct capture channel is not open.'))
    }
    return captureQueue.enqueue(frame)
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
