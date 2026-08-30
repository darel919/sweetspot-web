export const PROTOCOL_VERSION = 1 as const

export const MAX_PAYLOAD_BYTES = 16 * 1024
export const MAX_CALIBRATION_CAPTURE_METADATA_BYTES = 64 * 1024
export const MAX_CALIBRATION_CAPTURE_BYTES = 2 * 1024 * 1024

export type Role = 'device' | 'client'

export interface Envelope<P = unknown> {
  v: typeof PROTOCOL_VERSION
  id: string
  type: string
  ts: number
  payload: P
  replyTo?: string
  expiresAt?: number
  transportSessionId?: string
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function serializedUtf8ByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? Number.POSITIVE_INFINITY : utf8ByteLength(serialized)
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export function isEnvelopeWithinSizeLimit(value: unknown): boolean {
  return serializedUtf8ByteLength(value) <= MAX_PAYLOAD_BYTES
}

export function normalizePairCode(code: string): string {
  return code.replaceAll('-', '').trim().toUpperCase()
}

export const PAIR_CODE_PATTERN = /^[A-Z0-9]{6,10}$/

export function isValidPairCode(code: string): boolean {
  return PAIR_CODE_PATTERN.test(normalizePairCode(code))
}

export interface DeviceInfo {
  id: string
  name: string
  appVersion: string
  buildId?: string
}

export type TransportDiagnosticState =
  | 'idle'
  | 'pairing'
  | 'signaling'
  | 'connecting'
  | 'direct'
  | 'reconnecting'
  | 'failed'
  | 'closed'

export interface TransportDiagnosticsPayload {
  state: TransportDiagnosticState
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
  lastError: string | null
}

export const CALIBRATION_PACKAGE_FORMAT = 'sweetspot.calibration' as const
export const CALIBRATION_PACKAGE_VERSION = 1 as const
export const CALIBRATION_PACKAGE_MAX_GAIN_DB = 12
export const CALIBRATION_ANALYSIS_REVISION = 'response-marker-pair-v4' as const
export const CALIBRATION_SWEEP_REVISION = 'android-sweep-v3' as const

export interface CalibrationPackage {
  format: typeof CALIBRATION_PACKAGE_FORMAT
  version: typeof CALIBRATION_PACKAGE_VERSION
  exportedAt: number
  analysisRevision: typeof CALIBRATION_ANALYSIS_REVISION
  sourceDevice: DeviceInfo
  active: boolean
  frequenciesHz: number[]
  bandsDb: number[]
  leftBandsDb?: number[]
  rightBandsDb?: number[]
  effectiveBandsDb?: number[]
  effectiveLeftBandsDb?: number[]
  effectiveRightBandsDb?: number[]
}

export interface EngineState {
  enabled: boolean
  hasControl: boolean
  activePreset: number
  presetName: string
}

export interface UserEqState {
  bandsDb: number[]
  frequenciesHz: number[]
  minDb: number
  maxDb: number
}

export interface CalibrationState {
  active: boolean
  bandsDb: number[]
  frequenciesHz: number[]
  requestedBandsDb?: number[]
  effectiveBandsDb?: number[]
  leftBandsDb?: number[]
  rightBandsDb?: number[]
  requestedLeftBandsDb?: number[]
  requestedRightBandsDb?: number[]
  effectiveLeftBandsDb?: number[]
  effectiveRightBandsDb?: number[]
  independent?: boolean
  headroomDb?: number
  headroomVerified?: boolean
  applicationVerified?: boolean
  applicationError?: string | null
  inputAttenuationDb?: number
  liveDspStatus?: 'verified' | 'degraded'
  transaction: CalibrationTransaction
}

export type CalibrationValidationStatus = 'pending' | 'rolling_back' | 'passed' | 'neutral' | 'worse' | 'inconclusive' | 'failed' | 'imported'

export const CALIBRATION_VALIDATION_WORSE_TOLERANCE_DB = 0.5

export type CalibrationTransaction =
  | { state: 'none' }
  | { state: 'restoring'; sessionId: string }
  | {
      state: 'candidate_pending'
      candidateId: string
      validationStatus: CalibrationValidationStatus
      /** Whether the live calibration snapshot captured before staging was active. */
      previousActive: boolean
      beforeDb: number | null
      afterDb: number | null
      reason: string | null
    }

export interface PresetOption {
  id: number
  name: string
}

export interface OkReply {
  ok: boolean
  error?: string
}

export interface ProfileListPayload {
  profiles: Array<{ id: string; name: string }>
}

export interface CalibrationCurvePayload extends CalibrationState {}

export interface CalibrationExportRequestPayload {}

export interface ProbeResultEntry {
  requested: number
  constructed: boolean
  hasControl: boolean
  enabled: boolean
  actualBands: number
  pass: boolean
  exception?: string | null
}

export interface CurveSummary {
  bandsTotal: number
  bandsCut: number
  bandsFlat: number
}

export interface PersistentProbeState {
  active: boolean
  bands: number
  curve?: string | null
  curveSummary?: CurveSummary | null
  leftCurveSummary?: CurveSummary | null
  rightCurveSummary?: CurveSummary | null
}

export type CalibrationChannel = 'both' | 'left' | 'right'

export type CalibrationPositionId = 'center' | 'left' | 'right' | 'forward' | 'backward'

export type CalibrationPositionReference = 'center'

export type CalibrationJobStartMode = 'auto' | 'advanced'

export interface CalibrationJobStartPayload {
  mode: CalibrationJobStartMode
}

export interface CalibrationJobGetPayload {
  jobId?: string
}

export interface CalibrationJobIdPayload {
  jobId: string
}

export type CalibrationJobCancelScope = 'capture' | 'optional_refinement'

export interface CalibrationJobCancelPayload extends CalibrationJobIdPayload {
  scope: CalibrationJobCancelScope
  captureId?: string
  captureAttemptId?: string
}

export interface CalibrationJobDiscardPayload extends CalibrationJobIdPayload {}

export interface CalibrationJobFinishPayload extends CalibrationJobIdPayload {}

export type CalibrationJobPhase =
  | 'center_preflight'
  | 'measuring_required'
  | 'usable'
  | 'refining'
  | 'candidate_pending'
  | 'validating'
  | 'reoptimizing'
  | 'restoring'
  | 'complete'
  | 'failed'
  | 'cancelled'

export type CalibrationUsabilityGrade = 'bounded_usable' | 'sufficient'

export type CalibrationCorrectionMode = 'normal' | 'gentle' | 'restricted_band'

export type CalibrationValidationOutcome =
  | 'improved'
  | 'neutral'
  | 'worse'
  | 'inconclusive_capture'
  | 'dsp_error'

export type CalibrationValidationState =
  | 'none'
  | 'pending'
  | 'rolling_back'
  | 'passed'
  | 'worse'
  | 'inconclusive'
  | 'failed'

export interface CalibrationConfidenceView {
  usableBandCount: number
  totalBandCount: 64
  score: number
  grade: CalibrationUsabilityGrade | null
}

export interface CalibrationSolutionView {
  solutionId: string
  sourcePositionIds: CalibrationPositionId[]
  confidence: CalibrationConfidenceView
  score: number
  correctionMode: CalibrationCorrectionMode
}

export type CalibrationNextAction =
  | {
      kind: 'capture'
      captureId: string
      positionId: CalibrationPositionId
      channel: 'left' | 'right'
      attemptIndex: number
      optional: boolean
      instruction: string
    }
  | {
      kind: 'validate'
      captureId: string
      positionId: 'center'
      candidateId: string
      attemptIndex: number
      instruction: string
    }
  | {
      kind: 'wait'
      message: string
    }
  | {
      kind: 'complete'
      solutionId: string
    }

export interface CalibrationJobErrorView {
  code: string
  message: string
}

export interface CalibrationJobView {
  jobId: string
  createdAtMs: number
  revision: number
  analyzerRevision: string
  sweepRevision: string
  mode?: CalibrationJobStartMode
  phase: CalibrationJobPhase
  acceptedPositions: CalibrationPositionId[]
  excludedPositions: CalibrationPositionId[]
  historicalAttemptCount: number
  optionalFailureCount: number
  minimumViableCalibration: boolean
  bestSolution: CalibrationSolutionView | null
  confidence: CalibrationConfidenceView | null
  nextAction: CalibrationNextAction | null
  activeCandidateId: string | null
  validationState: CalibrationValidationState
  lastError: CalibrationJobErrorView | null
}

export interface CalibrationJobStatePayload extends CalibrationJobView {}

export type CalibrationCaptureChannel = 'left' | 'right' | 'both'

export interface CalibrationCaptureSettings {
  echoCancellation: boolean | null
  noiseSuppression: boolean | null
  autoGainControl: boolean | null
}

export type CalibrationMicrophoneProfileStatus = 'validated' | 'provisional' | 'unvalidated'

const CALIBRATION_MIC_PROFILE_MIN_FREQUENCY_HZ = 1
const CALIBRATION_MIC_PROFILE_MAX_FREQUENCY_HZ = 192_000
const CALIBRATION_MIC_PROFILE_MAX_RESPONSE_DB = 120

export interface CalibrationMicrophoneProfilePayload {
  id: string
  revision: string
  capturePathStatus: CalibrationMicrophoneProfileStatus
  frequenciesHz: number[]
  responseDb: number[]
  normalizeAtHz: number
  trustMinHz: number
  trustFullMaxHz: number
  trustTaperToHz: number
}

export interface CalibrationCaptureMetadata {
  jobId: string
  captureId: string
  positionId: CalibrationPositionId
  attemptIndex: number
  channel: CalibrationCaptureChannel
  sampleRate: number
  channelCount: 1
  sampleCount: number
  byteCount: number
  settings: CalibrationCaptureSettings
  userAgent: string
  microphoneProfileId: string
  microphoneProfileRevision: string
  microphoneProfile: CalibrationMicrophoneProfilePayload
  capturedAtMs: number
}

export interface CalibrationCaptureFrameMetadata extends CalibrationCaptureMetadata {
  contentSha256: string
}

export interface CalibrationCaptureReadyPayload {
  jobId: string
  captureId: string
  captureAttemptId: string
}

export interface CalibrationCaptureFinishedPayload extends CalibrationCaptureReadyPayload {}

export interface CalibrationCaptureStartedPayload extends CalibrationCaptureReadyPayload {}

export interface CalibrationCaptureWindowPayload {
  captureId: string
  captureAttemptId: string
  nextSequence: number
  windowSize: number
}

export type CalibrationCaptureUploadStatus = 'accepted' | 'rejected' | 'duplicate'

export interface CalibrationCaptureUploadedPayload {
  jobId: string
  captureId: string
  captureAttemptId: string
  contentSha256: string
  sampleCount: number
  byteCount: number
  status: CalibrationCaptureUploadStatus
  reason?: string
}

export interface CalibrationCaptureRejectedPayload {
  jobId: string
  captureId: string
  captureAttemptId: string
  reason: string
}

export interface CalibrationValidationCaptureReadyPayload {
  jobId: string
  captureId: string
  captureAttemptId: string
  candidateId: string
}

/** Absolute microphone target from the original center listening point. */
export interface CalibrationPositionTarget {
  reference: CalibrationPositionReference
  /** Horizontal offset in cm. Negative is left; positive is right. */
  xCm: number
  /** Vertical offset in cm. Negative is down; positive is up. */
  yCm: number
  /** Depth offset in cm. Positive is toward the TV; negative is away. */
  zCm: number
}

export const CALIBRATION_POSITION_TARGETS = {
  center: { reference: 'center', xCm: 0, yCm: 0, zCm: 0 },
  left: { reference: 'center', xCm: -35, yCm: 0, zCm: 0 },
  right: { reference: 'center', xCm: 35, yCm: 0, zCm: 0 },
  forward: { reference: 'center', xCm: 0, yCm: 10, zCm: 35 },
  backward: { reference: 'center', xCm: 0, yCm: -10, zCm: -35 },
} as const satisfies Record<CalibrationPositionId, CalibrationPositionTarget>

export type MeasurementPhase = 'measurement' | 'validation'

export type MeasurementRepairChannel = 'both' | 'left' | 'right'

export type MeasurementCaptureKind = 'position-composite' | 'marker-only' | 'marker-production-spacing'

export type MeasurementMarkerChannel = 'left' | 'right'

export function isMeasurementCaptureKind(value: unknown): value is MeasurementCaptureKind {
  return value === 'position-composite'
    || value === 'marker-only'
    || value === 'marker-production-spacing'
}

export function isMarkerDiagnosticCaptureKind(value: MeasurementCaptureKind): boolean {
  return value === 'marker-only' || value === 'marker-production-spacing'
}

export type CalibrationProgressStage =
  | 'loudness'
  | 'preparing'
  | 'recording'
  | 'analyzing'
  | 'position-pause'
  | 'validation'
  | 'ending'

export interface MeasurementContext {
  positionId: CalibrationPositionId
  reference: CalibrationPositionReference
  xCm: number
  yCm: number
  zCm: number
  positionIndex: number
  positionCount: number
  channel: CalibrationChannel
  captureKind: MeasurementCaptureKind
  repairChannel: MeasurementRepairChannel
  attemptIndex: number
  attemptCount: number
  phase: MeasurementPhase
}

export const CALIBRATION_ERROR_CODES = [
  'audio_focus_denied',
  'audio_focus_lost',
  'calibration_ui_failed',
  'calibration_ui_closed',
  'measurement_timeout',
  'sweep_playback_failed',
  'invalid_session',
  'already_measuring',
  'capture_clipped',
  'capture_too_short',
  'capture_sample_rate_changed',

  'direct_arrival_low_confidence',
  'impulse_not_found',
  'response_not_generated',
  'sync_marker_not_found',
  'clock_drift_unreliable',
  'signal_too_low',
  'measurement_unstable',
  'dsp_state_unverified',
  'dsp_restore_failed',
  'candidate_rollback_failed',
  'calibration_aborted',
] as const

export type CalibrationErrorCode = (typeof CALIBRATION_ERROR_CODES)[number]

export interface CalibrationSessionPayload {
  sessionId: string
  channel?: CalibrationChannel
  phase?: MeasurementPhase
}

export interface CalibrationSessionBeginPayload extends CalibrationSessionPayload {
  channel: CalibrationChannel
  phase?: MeasurementPhase
  candidateId?: string
}

export type CalibrationSessionOutcome = 'sufficient' | 'bounded' | 'insufficient' | 'cancelled' | 'error'

export interface CalibrationSessionEndPayload extends CalibrationSessionPayload {
  outcome: CalibrationSessionOutcome
}

export interface CalibrationSessionEndedPayload extends CalibrationSessionPayload {
  outcome: CalibrationSessionOutcome
  completedSessionId: string
}

export interface CalibrationSessionAbortPayload extends CalibrationSessionPayload {
  code: CalibrationErrorCode
  message?: string
}

export interface CalibrationSessionProgressPayload extends CalibrationSessionPayload {
  stage: CalibrationProgressStage
  current: number
  total: number
  estimatedRemainingSeconds?: number
  message?: string
}

export interface CalibrationLoudnessStartedPayload extends CalibrationSessionPayload {
  sampleRate: number
  levelDbfs: number
  loopDurationMs: number
}

export interface CalibrationLoudnessStoppedPayload extends CalibrationSessionPayload {}

export interface CalibrationSessionPositionContinuedPayload extends CalibrationSessionPayload {
  context: MeasurementContext
}

export interface MeasurementSweep {
  sweepRevision: typeof CALIBRATION_SWEEP_REVISION
  algorithm: 'exponential-sine-v1'
  captureKind: MeasurementCaptureKind
  markerChannel: MeasurementMarkerChannel
  sampleRate: number
  startHz: number
  endHz: number
  durationMs: number
  preRollMs: number
  postRollMs: number
  syncMarkerStartHz: number
  syncMarkerEndHz: number
  syncMarkerDurationMs: number
  syncMarkerGapMs: number
  endMarkerStartHz: number
  endMarkerEndHz: number
  endMarkerDurationMs: number
  interSweepGapMs: number
  sweepLevelDbfs: number
  markerLevelDbfs: number
  fadeInMs: number
  fadeOutMs: number
}

export interface MeasurementPreparePayload extends CalibrationSessionPayload {
  channel: CalibrationChannel
  context?: MeasurementContext
}

export interface MeasurementPlaySweepPayload extends CalibrationSessionPayload {
  context?: MeasurementContext
}

export interface MeasurementAbortPayload extends CalibrationSessionPayload {}

export interface MeasurementReadyPayload extends CalibrationSessionPayload {
  sweep: MeasurementSweep
  context?: MeasurementContext
}

export interface MeasurementStartedPayload extends CalibrationSessionPayload {
  sweep: MeasurementSweep
  context?: MeasurementContext
}

export interface MeasurementFinishedPayload extends CalibrationSessionPayload {
  context?: MeasurementContext
}

export interface MeasurementErrorPayload extends CalibrationSessionPayload {
  code: CalibrationErrorCode
  message?: string
}

export type MeasurementSyncMarkerFailureReason =
  | 'marker_absent'
  | 'leading_marker_weak'
  | 'trailing_marker_weak'
  | 'marker_pair_low_confidence'
  | 'marker_pair_ambiguous'
  | 'marker_pair_bad_timing'
  | 'end_marker_missing'
  | 'clock_drift_unreliable'

export interface MeasurementMarkerCandidate {
  sample: number
  correlation: number
}

export interface MeasurementMarkerPairCandidate {
  leadingSample: number
  trailingSample: number
  leadingCorrelation: number
  trailingCorrelation: number
  observedSeparationSamples: number
  separationPpm: number
  timingAgreement: number
  pairScore: number
  accepted: boolean
  rejectionReason: MeasurementSyncMarkerFailureReason | null
}

export interface MeasurementDiagnosticsValues {
  channel?: 'left' | 'right' | 'both'
  analysisStatus?: 'ok' | 'not_measured' | 'signal_too_low' | 'direct_arrival_low_confidence' | 'impulse_not_found' | 'response_not_generated' | 'sync_marker_not_found' | 'clock_drift_unreliable' | 'capture_too_short' | 'capture_clipped'
  failureReason?: string | null
  signalRms: number
  signalPeak: number
  snrEstimateDb: number | null
  detectionOffsetMs: number | null
  envelopeOnlyOffsetMs?: number | null
  startMarkerSample?: number | null
  endMarkerSample?: number | null
  expectedMarkerSeparationSamples?: number | null
  observedMarkerSeparationSamples?: number | null
  syncMarkerConfidence: number
  endingMarkerConfidence: number
  rawLeadingMarkerConfidence?: number
  rawTrailingMarkerConfidence?: number
  bestLeadingMarkerSample?: number | null
  bestTrailingMarkerSample?: number | null
  leadingMarkerCandidates?: MeasurementMarkerCandidate[]
  trailingMarkerCandidates?: MeasurementMarkerCandidate[]
  markerPairCandidates?: MeasurementMarkerPairCandidate[]
  leadingBestCorrelation?: number | null
  leadingSecondCorrelation?: number | null
  leadingCorrelationMargin?: number | null
  trailingBestCorrelation?: number | null
  trailingSecondCorrelation?: number | null
  trailingCorrelationMargin?: number | null
  markerPairScore?: number | null
  secondMarkerPairScore?: number | null
  markerPairScoreMargin?: number | null
  markerPairScoreRatio?: number | null
  markerSeparationError?: number | null
  markerTimingAgreement?: number | null
  syncMarkerFailureReason?: MeasurementSyncMarkerFailureReason | null
  /** Raw marker-separation estimate; it is not necessarily oscillator drift. */
  markerSeparationPpm?: number | null
  clockDriftPpm: number | null
  clipped: boolean
  clippedSamples: number
  directArrivalMs: number | null
  directPeak?: number | null
  deconvolvedNoiseFloorRms?: number | null
  directPeakToNoiseDb?: number | null
  directArrivalAcceptanceThreshold?: number | null
  directArrivalCandidateSample?: number | null
  directArrivalAcceptedSample?: number | null
  directArrivalRejectionReason?: string | null
  directSupportWindowRms?: number | null
  directSupportWindowThreshold?: number | null
  directSupportSampleCount?: number | null
  bestLaterReflectionSample?: number | null
  bestLaterReflectionPeak?: number | null
  candidateAbsoluteTimeMs?: number | null
  earlySearchWindowStartSample?: number | null
  earlySearchWindowEndSample?: number | null
  topEarlyImpulsePeaks?: Array<{ sample: number; amplitude: number; peakToNoiseDb: number | null }>
  strongestLaterReflectionDelayMs?: number | null
  localSupportWindowStartSample?: number | null
  localSupportWindowEndSample?: number | null
  localSupportWindowMax?: number | null
  localSupportSampleCount?: number | null
  directToLateDb: number | null
  c50Db: number | null
  c80Db: number | null
  edtMs: number | null
  t20Ms: number | null
  t30Ms: number | null
  earlyReflections: number
  decayConfidence: 'high' | 'medium' | 'low'
  captureMetadata?: MeasurementCaptureMetadata
}

export interface CompactMeasurementCaptureMetadata {
  sampleRate: number | null
  channelCount: number | null
  echoCancellation: boolean | null
  noiseSuppression: boolean | null
  autoGainControl: boolean | null
  trackSampleRate?: number | null
  trackChannelCount?: number | null
}

export type CompactMeasurementDiagnosticsValues = Omit<MeasurementDiagnosticsValues,
  | 'leadingMarkerCandidates'
  | 'trailingMarkerCandidates'
  | 'markerPairCandidates'
  | 'topEarlyImpulsePeaks'
  | 'captureMetadata'
> & {
  captureMetadata?: CompactMeasurementCaptureMetadata
}

export interface MeasurementCaptureMetadata {
  sampleRate: number | null
  channelCount: number | null
  echoCancellation: boolean | null
  noiseSuppression: boolean | null
  autoGainControl: boolean | null
  sampleRateRange: { min: number; max: number } | null
  channelCountRange: { min: number; max: number } | null
  echoCancellationCapabilities: boolean[]
  noiseSuppressionCapabilities: boolean[]
  autoGainControlCapabilities: boolean[]
  browserUserAgent?: string
  micProfileId?: string
  micProfileSourceDate?: string
  micProfileCapturePathStatus?: 'validated' | 'provisional' | 'unvalidated'
  trackSampleRate?: number | null
  trackChannelCount?: number | null
}

export interface MeasurementDiagnosticsPayload extends CalibrationSessionPayload {
  context: MeasurementContext
  current: number
  total: number
  diagnostics: CompactMeasurementDiagnosticsValues
}

export interface MeasurementResponseChannel {
  frequenciesHz: number[]
  magnitudesDb: number[]
}

export interface MeasurementResponsePayload extends CalibrationSessionPayload {
  current: number
  total: number
  left: MeasurementResponseChannel | null
  right: MeasurementResponseChannel | null
}

/** Reply to probe.run / probe.status: DynamicsProcessing capacity + persistent instance state. */
export interface ProbeDiagnostics {
  running: boolean
  available: boolean
  results: ProbeResultEntry[]
  highest: number
  recommended: number
  persistent?: PersistentProbeState
}

export interface DeviceInfoPayload {
  javaHeapMax: number
  javaHeapTotal: number
  javaHeapFree: number
  nativeHeapAllocated: number
  nativeHeapSize: number
  pssTotalKb: number
  privateDirtyKb: number
  cpuPercent: number
  audioserverCpuPercent: number
  audioserverPid: number | null
  persistentProbeActive: boolean
  persistentProbeBands: number
}

export interface DeviceCapabilities {
  channels: number
  calibrationBandCount: number
  userBandCount: number
  supportsSweep: boolean
  supportsIndependentCalibration: boolean
  supportsCalibratedCorrection: boolean
  supportsHeadroomCompensation: boolean
  presets: PresetOption[]
}

export interface EffectInventoryEntry {
  name: string
  typeName: string
  typeUuid: string
  implUuid: string
  connectMode: string
  isVendor: boolean
}

export interface SessionProbe {
  effectType: string
  constructed: boolean
  hasControl: boolean
  enabled: boolean
  parameters: string
  exception?: string | null
}

export interface EffectsDiagnostics {
  inventory: EffectInventoryEntry[]
  sessionProbes: SessionProbe[]
  error?: string
}

export interface StateSnapshot {
  stateRevision: number
  device: DeviceInfo
  engine: EngineState
  userEq: UserEqState
  calibration: CalibrationState
  profiles: Array<{ id: string; name: string }>
  capabilities: DeviceCapabilities
}

export interface StateGetPayload {}

function isCalibrationTransaction(value: unknown): value is CalibrationTransaction {
  if (!isRecord(value)) return false
  if (value.state === 'none') return true
  if (value.state === 'restoring') return isSessionId(value.sessionId)
  return value.state === 'candidate_pending'
    && isCandidateId(value.candidateId)
    && (value.validationStatus === 'pending'
      || value.validationStatus === 'rolling_back'
      || value.validationStatus === 'passed'
      || value.validationStatus === 'neutral'
      || value.validationStatus === 'worse'
      || value.validationStatus === 'inconclusive'
      || value.validationStatus === 'failed'
      || value.validationStatus === 'imported')
    && typeof value.previousActive === 'boolean'
    && isNullableFiniteNumber(value.beforeDb)
    && isNullableFiniteNumber(value.afterDb)
    && (value.reason === null || typeof value.reason === 'string')
}

function isPresetOption(value: unknown): value is PresetOption {
  return isRecord(value)
    && isInteger(value.id)
    && typeof value.name === 'string'
    && value.name.length <= 128
}

export function isStateSnapshot(value: unknown): value is StateSnapshot {
  if (!isRecord(value)
    || !isRecord(value.device)
    || !isRecord(value.engine)
    || !isRecord(value.userEq)
    || !isRecord(value.calibration)
    || !Array.isArray(value.profiles)
    || !isRecord(value.capabilities)
  ) return false
  const device = value.device
  const engine = value.engine
  const userEq = value.userEq
  const calibration = value.calibration
  const capabilities = value.capabilities
  const userBands = Array.isArray(userEq.bandsDb) && userEq.bandsDb.every(isFiniteNumber)
  const userFrequencies = Array.isArray(userEq.frequenciesHz) && userEq.frequenciesHz.every(isFiniteNumber)
  const calibrationArrays = isDbArray(calibration.bandsDb)
    && Array.isArray(calibration.frequenciesHz)
    && calibration.frequenciesHz.length === 64
    && calibration.frequenciesHz.every(isFiniteNumber)
    && (calibration.requestedBandsDb === undefined || isDbArray(calibration.requestedBandsDb))
    && (calibration.effectiveBandsDb === undefined || isDbArray(calibration.effectiveBandsDb))
    && (calibration.leftBandsDb === undefined || isDbArray(calibration.leftBandsDb))
    && (calibration.rightBandsDb === undefined || isDbArray(calibration.rightBandsDb))
    && (calibration.requestedLeftBandsDb === undefined || isDbArray(calibration.requestedLeftBandsDb))
    && (calibration.requestedRightBandsDb === undefined || isDbArray(calibration.requestedRightBandsDb))
    && (calibration.effectiveLeftBandsDb === undefined || isDbArray(calibration.effectiveLeftBandsDb))
    && (calibration.effectiveRightBandsDb === undefined || isDbArray(calibration.effectiveRightBandsDb))
  return isInteger(value.stateRevision) && value.stateRevision >= 0
    && typeof device.id === 'string'
    && typeof device.name === 'string'
    && typeof device.appVersion === 'string'
    && typeof engine.enabled === 'boolean'
    && typeof engine.hasControl === 'boolean'
    && isInteger(engine.activePreset)
    && typeof engine.presetName === 'string'
    && userBands
    && userFrequencies
    && userEq.bandsDb.length === userEq.frequenciesHz.length
    && isFiniteNumber(userEq.minDb)
    && isFiniteNumber(userEq.maxDb)
    && userEq.minDb <= userEq.maxDb
    && typeof calibration.active === 'boolean'
    && calibrationArrays
    && (calibration.independent === undefined || typeof calibration.independent === 'boolean')
    && (calibration.headroomDb === undefined || isFiniteNumber(calibration.headroomDb))
    && (calibration.headroomVerified === undefined || typeof calibration.headroomVerified === 'boolean')
    && (calibration.applicationVerified === undefined || typeof calibration.applicationVerified === 'boolean')
    && (calibration.applicationError === undefined || calibration.applicationError === null || typeof calibration.applicationError === 'string')
    && (calibration.inputAttenuationDb === undefined || isFiniteNumber(calibration.inputAttenuationDb))
    && (calibration.liveDspStatus === undefined || calibration.liveDspStatus === 'verified' || calibration.liveDspStatus === 'degraded')
    && isCalibrationTransaction(calibration.transaction)
    && value.profiles.every((profile) => isRecord(profile)
      && typeof profile.id === 'string'
      && typeof profile.name === 'string')
    && isInteger(capabilities.channels)
    && capabilities.channels >= 1
    && isInteger(capabilities.calibrationBandCount)
    && capabilities.calibrationBandCount === 64
    && isInteger(capabilities.userBandCount)
    && capabilities.userBandCount === userEq.bandsDb.length
    && typeof capabilities.supportsSweep === 'boolean'
    && typeof capabilities.supportsIndependentCalibration === 'boolean'
    && typeof capabilities.supportsCalibratedCorrection === 'boolean'
    && typeof capabilities.supportsHeadroomCompensation === 'boolean'
    && Array.isArray(capabilities.presets)
    && capabilities.presets.every(isPresetOption)
}

/** Command payloads (client to device). */

export interface SetBandsPayload {
  bandsDb: number[]
}

export interface ApplyPresetPayload {
  preset: number
}

export interface ProfileNamePayload {
  name: string
}

export interface CalibrationApplyPayload {
  bandsDb: number[]
  leftBandsDb?: number[]
  rightBandsDb?: number[]
}

export interface CalibrationCandidateActionPayload {
  candidateId: string
}

export type CalibrationValidationResultPayload =
  | {
      candidateId: string
      status: 'passed' | 'worse'
      beforeDb: number
      afterDb: number
    }
  | {
      candidateId: string
      status: 'inconclusive' | 'failed'
      reason: string
    }

export interface ProbeRunPayload {
  bands: number
}

export interface PersistentProbePayload {
  bands: number
}

export interface CurveApplyPayload {
  curve: 'hollow' | 'flat'
}

export interface ProbeBandsApplyPayload {
  bandsDb: number[]
  leftBandsDb?: number[]
  rightBandsDb?: number[]
}

export type ProbeCurveApplyPayload = CurveApplyPayload | ProbeBandsApplyPayload

const DEVICE_TARGETED_TYPES = [
  'state.get',
  'engine.enable',
  'engine.bypass',
  'engine.setBands',
  'engine.applyPreset',
  'virtualizer.on',
  'virtualizer.off',
  'profile.list',
  'profile.save',
  'profile.load',
  'profile.delete',
  'calibration.get',
  'calibration.reset',
  'calibration.export',
  'calibration.import',
  'calibration.job.start',
  'calibration.job.get',
  'calibration.job.cancel',
  'calibration.job.discard',
  'calibration.job.finish',
  'calibration.capture.ready',
  'calibration.validation.capture.ready',
  'calibrationSession.begin',
  'diagnostics.calibrationSession.end',
  'calibrationSession.abort',
  'calibrationSession.loudness.start',
  'calibrationSession.loudness.stop',
  'calibrationSession.progress',
  'measurement.prepare',
  'measurement.playSweep',
  'measurement.abort',
  'measurement.diagnostics',
  'measurement.response',
  'probe.run',
  'probe.status',
  'probe.persistent.start',
  'probe.persistent.release',
  'probe.curve.apply',
  'diagnostics.deviceInfo',
  'diagnostics.effects',
  'diagnostics.transport',
] as const

export type DeviceTargetedType = (typeof DEVICE_TARGETED_TYPES)[number]

export const CLIENT_TO_DEVICE_TYPES = new Set<string>([
  ...DEVICE_TARGETED_TYPES,
  'ping',
])

export const DEVICE_TO_CLIENT_TYPES = new Set<string>([
  'pong',
  'state.snapshot',
  'state.changed',
  'calibrationSession.started',
  'calibrationSession.ended',
  'calibrationSession.loudness.started',
  'calibrationSession.loudness.stopped',
  'calibrationSession.position.continued',
  'measurement.ready',
  'measurement.started',
  'measurement.finished',
  'measurement.error',
  'calibration.exported',
  'calibration.capture.uploaded',
  'calibration.capture.rejected',
  'calibration.capture.finished',
  'calibration.capture.started',
  'calibration.capture.window',
  'calibration.job.state',
  'probe.status',
  'probe.result',
  'diagnostics.deviceInfo',
  'diagnostics.probe',
  'diagnostics.effects',
  'diagnostics.transport',
])

export const KNOWN_TYPES = new Set<string>([
  ...DEVICE_TARGETED_TYPES,
  'ping',
  'pong',
  'state.snapshot',
  'state.changed',
  'calibrationSession.started',
  'calibrationSession.ended',
  'calibrationSession.loudness.started',
  'calibrationSession.loudness.stopped',
  'calibrationSession.position.continued',
  'measurement.ready',
  'measurement.started',
  'measurement.finished',
  'measurement.error',
  'calibration.exported',
  'calibration.capture.uploaded',
  'calibration.capture.rejected',
  'calibration.capture.finished',
  'calibration.capture.started',
  'calibration.capture.window',
  'calibration.job.state',
  'probe.status',
  'probe.result',
  'diagnostics.deviceInfo',
  'diagnostics.probe',
  'diagnostics.effects',
  'diagnostics.transport',
])

export function isDeviceTargeted(type: string): type is DeviceTargetedType {
  return DEVICE_TARGETED_TYPES.some((candidate) => candidate === type)
}

export function isClientToDevice(type: string): boolean {
  return CLIENT_TO_DEVICE_TYPES.has(type)
}

export function isDeviceToClient(type: string): boolean {
  return DEVICE_TO_CLIENT_TYPES.has(type)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function isSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    // eslint-disable-next-line no-control-regex -- intentionally rejects control characters and whitespace in session ids
    && !/[\u0000-\u001f\u007f\s]/.test(value)
}

function isCalibrationChannel(value: unknown): value is CalibrationChannel {
  return value === 'both' || value === 'left' || value === 'right'
}

function isCalibrationPositionId(value: unknown): value is CalibrationPositionId {
  return value === 'center'
    || value === 'left'
    || value === 'right'
    || value === 'forward'
    || value === 'backward'
}

function isCalibrationPositionTarget(value: Record<string, unknown>, positionId: CalibrationPositionId): boolean {
  const target = CALIBRATION_POSITION_TARGETS[positionId]
  return value.reference === target.reference
    && value.xCm === target.xCm
    && value.yCm === target.yCm
    && value.zCm === target.zCm
}

function isMeasurementPhase(value: unknown): value is MeasurementPhase {
  return value === 'measurement' || value === 'validation'
}

function isCalibrationProgressStage(value: unknown): value is CalibrationProgressStage {
  return value === 'loudness'
    || value === 'preparing'
    || value === 'recording'
    || value === 'analyzing'
    || value === 'position-pause'
    || value === 'validation'
    || value === 'ending'
}

export function isMeasurementContext(value: unknown): value is MeasurementContext {
  if (!isRecord(value)) return false
  if (!isCalibrationPositionId(value.positionId)) return false
  if (!isCalibrationPositionTarget(value, value.positionId)) return false
  if (!isInteger(value.positionIndex) || value.positionIndex < 0 || value.positionIndex >= 16) return false
  if (!isInteger(value.positionCount) || value.positionCount < 1 || value.positionCount > 16) return false
  if (value.positionIndex >= value.positionCount) return false
  if (value.channel !== 'both') return false
  if (!isMeasurementCaptureKind(value.captureKind)) return false
  if (value.repairChannel !== 'both' && value.repairChannel !== 'left' && value.repairChannel !== 'right') return false
  if (!isInteger(value.attemptIndex) || value.attemptIndex < 0 || value.attemptIndex >= 2) return false
  if (!isInteger(value.attemptCount) || value.attemptCount < 1 || value.attemptCount > 2) return false
  if (value.attemptIndex >= value.attemptCount) return false
  return isMeasurementPhase(value.phase)
}

function isCalibrationErrorCode(value: unknown): value is CalibrationErrorCode {
  return CALIBRATION_ERROR_CODES.some((code) => code === value)
}

function hasOptionalMessage(value: Record<string, unknown>): boolean {
  return value.message === undefined
    || (typeof value.message === 'string' && value.message.length <= 1024)
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
}

function isLoudnessStartedPayload(value: unknown): value is Record<string, unknown> & CalibrationLoudnessStartedPayload {
  return isSessionPayload(value)
    && isFiniteNumber(value.sampleRate)
    && Number.isInteger(value.sampleRate)
    && value.sampleRate >= 8_000
    && value.sampleRate <= 192_000
    && isFiniteNumber(value.levelDbfs)
    && value.levelDbfs <= 0
    && value.levelDbfs >= -120
    && isFiniteNumber(value.loopDurationMs)
    && value.loopDurationMs > 0
    && value.loopDurationMs <= 60_000
}

function isProgressPayload(value: unknown): value is Record<string, unknown> & CalibrationSessionProgressPayload {
  if (!isSessionPayload(value) || !isCalibrationProgressStage(value.stage)) return false
  const current = value.current
  const total = value.total
  const estimate = value.estimatedRemainingSeconds
  return isInteger(current)
    && current >= 0
    && isInteger(total)
    && total >= 1
    && total <= 256
    && current <= total
    && (estimate === undefined || (isFiniteNumber(estimate) && estimate >= 0 && estimate <= 3_600))
    && hasOptionalMessage(value)
}

function isMeasurementMarkerCandidate(value: unknown): value is MeasurementMarkerCandidate {
  return isRecord(value)
    && isFiniteNumber(value.sample)
    && value.sample >= 0
    && isFiniteNumber(value.correlation)
    && value.correlation >= 0
    && value.correlation <= 1
}

function isCompactMeasurementCaptureMetadata(value: unknown): value is CompactMeasurementCaptureMetadata {
  return isRecord(value)
    && !['sampleRateRange', 'channelCountRange', 'echoCancellationCapabilities', 'noiseSuppressionCapabilities', 'autoGainControlCapabilities', 'browserUserAgent', 'micProfileId', 'micProfileSourceDate', 'micProfileCapturePathStatus']
      .some((field) => field in value)
    && isNullableFiniteNumber(value.sampleRate)
    && isNullableFiniteNumber(value.channelCount)
    && (value.echoCancellation === null || typeof value.echoCancellation === 'boolean')
    && (value.noiseSuppression === null || typeof value.noiseSuppression === 'boolean')
    && (value.autoGainControl === null || typeof value.autoGainControl === 'boolean')
    && (value.trackSampleRate === undefined || isNullableFiniteNumber(value.trackSampleRate))
    && (value.trackChannelCount === undefined || isNullableFiniteNumber(value.trackChannelCount))
}

function isMeasurementMarkerPairCandidate(value: unknown): value is MeasurementMarkerPairCandidate {
  return isRecord(value)
    && isFiniteNumber(value.leadingSample)
    && value.leadingSample >= 0
    && isFiniteNumber(value.trailingSample)
    && value.trailingSample > value.leadingSample
    && isFiniteNumber(value.leadingCorrelation)
    && value.leadingCorrelation >= 0
    && value.leadingCorrelation <= 1
    && isFiniteNumber(value.trailingCorrelation)
    && value.trailingCorrelation >= 0
    && value.trailingCorrelation <= 1
    && isFiniteNumber(value.observedSeparationSamples)
    && value.observedSeparationSamples > 0
    && isFiniteNumber(value.separationPpm)
    && isFiniteNumber(value.timingAgreement)
    && value.timingAgreement >= 0
    && value.timingAgreement <= 1
    && isFiniteNumber(value.pairScore)
    && value.pairScore >= 0
    && value.pairScore <= 1
    && typeof value.accepted === 'boolean'
    && (value.rejectionReason === null
      || value.rejectionReason === undefined
      || value.rejectionReason === 'marker_absent'
      || value.rejectionReason === 'leading_marker_weak'
      || value.rejectionReason === 'trailing_marker_weak'
      || value.rejectionReason === 'marker_pair_low_confidence'
      || value.rejectionReason === 'marker_pair_ambiguous'
      || value.rejectionReason === 'marker_pair_bad_timing'
      || value.rejectionReason === 'end_marker_missing'
      || value.rejectionReason === 'clock_drift_unreliable')
}

function isMeasurementDiagnosticsPayload(value: unknown): value is Record<string, unknown> & MeasurementDiagnosticsPayload {
  if (!isSessionPayload(value) || !isMeasurementContext(value.context)) return false
  const current = value.current
  const total = value.total
  if (!isInteger(current) || current < 0) return false
  if (!isInteger(total) || total < 1 || total > 256 || current > total) return false
  if (!isRecord(value.diagnostics)) return false
  const diagnostics = value.diagnostics
  if ('leadingMarkerCandidates' in diagnostics
    || 'trailingMarkerCandidates' in diagnostics
    || 'markerPairCandidates' in diagnostics
    || 'topEarlyImpulsePeaks' in diagnostics) return false
  return (diagnostics.analysisStatus === undefined
      || diagnostics.analysisStatus === 'ok'
      || diagnostics.analysisStatus === 'not_measured'
      || diagnostics.analysisStatus === 'signal_too_low'

      || diagnostics.analysisStatus === 'direct_arrival_low_confidence'
      || diagnostics.analysisStatus === 'impulse_not_found'
      || diagnostics.analysisStatus === 'response_not_generated'
      || diagnostics.analysisStatus === 'sync_marker_not_found'
      || diagnostics.analysisStatus === 'clock_drift_unreliable'
      || diagnostics.analysisStatus === 'capture_too_short'
      || diagnostics.analysisStatus === 'capture_clipped')
    && (diagnostics.channel === undefined || diagnostics.channel === 'left' || diagnostics.channel === 'right' || diagnostics.channel === 'both')
    && (diagnostics.failureReason === undefined || diagnostics.failureReason === null || typeof diagnostics.failureReason === 'string')
    && isFiniteNumber(diagnostics.signalRms)
    && diagnostics.signalRms >= 0
    && isFiniteNumber(diagnostics.signalPeak)
    && diagnostics.signalPeak >= 0
    && isNullableFiniteNumber(diagnostics.snrEstimateDb)
    && isNullableFiniteNumber(diagnostics.detectionOffsetMs)
    && (diagnostics.detectionOffsetMs === null || diagnostics.detectionOffsetMs >= 0)
    && (!('envelopeOnlyOffsetMs' in diagnostics) || isNullableFiniteNumber(diagnostics.envelopeOnlyOffsetMs))
    && (!('startMarkerSample' in diagnostics) || isNullableFiniteNumber(diagnostics.startMarkerSample))
    && (!('endMarkerSample' in diagnostics) || isNullableFiniteNumber(diagnostics.endMarkerSample))
    && (!('expectedMarkerSeparationSamples' in diagnostics) || isNullableFiniteNumber(diagnostics.expectedMarkerSeparationSamples))
    && (!('observedMarkerSeparationSamples' in diagnostics) || isNullableFiniteNumber(diagnostics.observedMarkerSeparationSamples))
    && (!('rawLeadingMarkerConfidence' in diagnostics) || (
      isFiniteNumber(diagnostics.rawLeadingMarkerConfidence)
      && diagnostics.rawLeadingMarkerConfidence >= 0
      && diagnostics.rawLeadingMarkerConfidence <= 1
    ))
    && (!('rawTrailingMarkerConfidence' in diagnostics) || (
      isFiniteNumber(diagnostics.rawTrailingMarkerConfidence)
      && diagnostics.rawTrailingMarkerConfidence >= 0
      && diagnostics.rawTrailingMarkerConfidence <= 1
    ))
    && (!('bestLeadingMarkerSample' in diagnostics) || (
      isNullableFiniteNumber(diagnostics.bestLeadingMarkerSample)
      && (diagnostics.bestLeadingMarkerSample === null || diagnostics.bestLeadingMarkerSample >= 0)
    ))
    && (!('bestTrailingMarkerSample' in diagnostics) || (
      isNullableFiniteNumber(diagnostics.bestTrailingMarkerSample)
      && (diagnostics.bestTrailingMarkerSample === null || diagnostics.bestTrailingMarkerSample >= 0)
    ))
    && (!('leadingMarkerCandidates' in diagnostics)
      || (Array.isArray(diagnostics.leadingMarkerCandidates)
        && diagnostics.leadingMarkerCandidates.length <= 16
        && diagnostics.leadingMarkerCandidates.every(isMeasurementMarkerCandidate)))
    && (!('trailingMarkerCandidates' in diagnostics)
      || (Array.isArray(diagnostics.trailingMarkerCandidates)
        && diagnostics.trailingMarkerCandidates.length <= 16
        && diagnostics.trailingMarkerCandidates.every(isMeasurementMarkerCandidate)))
    && (!('markerPairCandidates' in diagnostics)
      || (Array.isArray(diagnostics.markerPairCandidates)
        && diagnostics.markerPairCandidates.length <= 16
        && diagnostics.markerPairCandidates.every(isMeasurementMarkerPairCandidate)))
    && (!('leadingBestCorrelation' in diagnostics) || isNullableFiniteNumber(diagnostics.leadingBestCorrelation))
    && (!('leadingSecondCorrelation' in diagnostics) || isNullableFiniteNumber(diagnostics.leadingSecondCorrelation))
    && (!('leadingCorrelationMargin' in diagnostics) || isNullableFiniteNumber(diagnostics.leadingCorrelationMargin))
    && (!('trailingBestCorrelation' in diagnostics) || isNullableFiniteNumber(diagnostics.trailingBestCorrelation))
    && (!('trailingSecondCorrelation' in diagnostics) || isNullableFiniteNumber(diagnostics.trailingSecondCorrelation))
    && (!('trailingCorrelationMargin' in diagnostics) || isNullableFiniteNumber(diagnostics.trailingCorrelationMargin))
    && (!('markerPairScore' in diagnostics) || (
      isNullableFiniteNumber(diagnostics.markerPairScore)
      && (diagnostics.markerPairScore === null || (diagnostics.markerPairScore >= 0 && diagnostics.markerPairScore <= 1))
    ))
    && (!('secondMarkerPairScore' in diagnostics) || (
      isNullableFiniteNumber(diagnostics.secondMarkerPairScore)
      && (diagnostics.secondMarkerPairScore === null || (diagnostics.secondMarkerPairScore >= 0 && diagnostics.secondMarkerPairScore <= 1))
    ))
    && (!('markerPairScoreMargin' in diagnostics) || isNullableFiniteNumber(diagnostics.markerPairScoreMargin))
    && (!('markerPairScoreRatio' in diagnostics) || isNullableFiniteNumber(diagnostics.markerPairScoreRatio))
    && (!('markerSeparationError' in diagnostics) || (
      isNullableFiniteNumber(diagnostics.markerSeparationError)
      && (diagnostics.markerSeparationError === null || diagnostics.markerSeparationError >= 0)
    ))
    && (!('markerTimingAgreement' in diagnostics) || (
      isNullableFiniteNumber(diagnostics.markerTimingAgreement)
      && (diagnostics.markerTimingAgreement === null
        || (diagnostics.markerTimingAgreement >= 0 && diagnostics.markerTimingAgreement <= 1))
    ))
    && (!('syncMarkerFailureReason' in diagnostics)
      || diagnostics.syncMarkerFailureReason === null
      || diagnostics.syncMarkerFailureReason === 'marker_absent'
      || diagnostics.syncMarkerFailureReason === 'leading_marker_weak'
      || diagnostics.syncMarkerFailureReason === 'trailing_marker_weak'
      || diagnostics.syncMarkerFailureReason === 'marker_pair_low_confidence'
      || diagnostics.syncMarkerFailureReason === 'marker_pair_ambiguous'
      || diagnostics.syncMarkerFailureReason === 'marker_pair_bad_timing'
      || diagnostics.syncMarkerFailureReason === 'end_marker_missing'
      || diagnostics.syncMarkerFailureReason === 'clock_drift_unreliable')
    && (!('markerSeparationPpm' in diagnostics) || isNullableFiniteNumber(diagnostics.markerSeparationPpm))
    && isFiniteNumber(diagnostics.syncMarkerConfidence)
    && diagnostics.syncMarkerConfidence >= 0
    && diagnostics.syncMarkerConfidence <= 1
    && isFiniteNumber(diagnostics.endingMarkerConfidence)
    && diagnostics.endingMarkerConfidence >= 0
    && diagnostics.endingMarkerConfidence <= 1
    && isNullableFiniteNumber(diagnostics.clockDriftPpm)
    && typeof diagnostics.clipped === 'boolean'
    && isInteger(diagnostics.clippedSamples)
    && diagnostics.clippedSamples >= 0
    && isNullableFiniteNumber(diagnostics.directArrivalMs)
    && (!('directPeak' in diagnostics) || isNullableFiniteNumber(diagnostics.directPeak))
    && (!('deconvolvedNoiseFloorRms' in diagnostics) || isNullableFiniteNumber(diagnostics.deconvolvedNoiseFloorRms))
    && (!('directPeakToNoiseDb' in diagnostics) || isNullableFiniteNumber(diagnostics.directPeakToNoiseDb))
    && (!('directArrivalAcceptanceThreshold' in diagnostics) || isNullableFiniteNumber(diagnostics.directArrivalAcceptanceThreshold))
    && (!('directArrivalCandidateSample' in diagnostics) || isNullableFiniteNumber(diagnostics.directArrivalCandidateSample))
    && (!('directArrivalAcceptedSample' in diagnostics) || isNullableFiniteNumber(diagnostics.directArrivalAcceptedSample))
    && (!('directArrivalRejectionReason' in diagnostics)
      || diagnostics.directArrivalRejectionReason === null
      || typeof diagnostics.directArrivalRejectionReason === 'string')
    && (!('directSupportWindowRms' in diagnostics) || isNullableFiniteNumber(diagnostics.directSupportWindowRms))
    && (!('directSupportWindowThreshold' in diagnostics) || isNullableFiniteNumber(diagnostics.directSupportWindowThreshold))
    && (!('directSupportSampleCount' in diagnostics) || (isInteger(diagnostics.directSupportSampleCount) && diagnostics.directSupportSampleCount >= 0))
    && (!('bestLaterReflectionSample' in diagnostics) || isNullableFiniteNumber(diagnostics.bestLaterReflectionSample))
    && (!('bestLaterReflectionPeak' in diagnostics) || isNullableFiniteNumber(diagnostics.bestLaterReflectionPeak))
    && (!('candidateAbsoluteTimeMs' in diagnostics) || isNullableFiniteNumber(diagnostics.candidateAbsoluteTimeMs))
    && (!('earlySearchWindowStartSample' in diagnostics) || isNullableFiniteNumber(diagnostics.earlySearchWindowStartSample))
    && (!('earlySearchWindowEndSample' in diagnostics) || isNullableFiniteNumber(diagnostics.earlySearchWindowEndSample))
    && (!('strongestLaterReflectionDelayMs' in diagnostics) || isNullableFiniteNumber(diagnostics.strongestLaterReflectionDelayMs))
    && (!('localSupportWindowStartSample' in diagnostics) || isNullableFiniteNumber(diagnostics.localSupportWindowStartSample))
    && (!('localSupportWindowEndSample' in diagnostics) || isNullableFiniteNumber(diagnostics.localSupportWindowEndSample))
    && (!('localSupportWindowMax' in diagnostics) || isNullableFiniteNumber(diagnostics.localSupportWindowMax))
    && (!('localSupportSampleCount' in diagnostics) || (isNullableFiniteNumber(diagnostics.localSupportSampleCount)
      && (diagnostics.localSupportSampleCount === null || Number.isInteger(diagnostics.localSupportSampleCount))))
    && (!('captureMetadata' in diagnostics) || isCompactMeasurementCaptureMetadata(diagnostics.captureMetadata))
    && isNullableFiniteNumber(diagnostics.directToLateDb)
    && isNullableFiniteNumber(diagnostics.c50Db)
    && isNullableFiniteNumber(diagnostics.c80Db)
    && isNullableFiniteNumber(diagnostics.edtMs)
    && isNullableFiniteNumber(diagnostics.t20Ms)
    && isNullableFiniteNumber(diagnostics.t30Ms)
    && isInteger(diagnostics.earlyReflections)
    && diagnostics.earlyReflections >= 0
    && (diagnostics.decayConfidence === 'high'
      || diagnostics.decayConfidence === 'medium'
      || diagnostics.decayConfidence === 'low')
}

const MAX_RESPONSE_POINTS = 64

function isMeasurementResponseChannel(value: unknown): value is MeasurementResponseChannel {
  if (!isRecord(value)) return false
  const frequenciesHz = value.frequenciesHz
  const magnitudesDb = value.magnitudesDb
  if (!Array.isArray(frequenciesHz) || !Array.isArray(magnitudesDb)) return false
  if (frequenciesHz.length < 2 || frequenciesHz.length > MAX_RESPONSE_POINTS || frequenciesHz.length !== magnitudesDb.length) {
    return false
  }
  let previousFrequency = 0
  for (let index = 0; index < frequenciesHz.length; index++) {
    const frequency = frequenciesHz[index]
    const magnitude = magnitudesDb[index]
    if (!isFiniteNumber(frequency) || frequency <= 0 || frequency <= previousFrequency || !isFiniteNumber(magnitude)) {
      return false
    }
    previousFrequency = frequency
  }
  return true
}

function isMeasurementResponsePayload(value: unknown): value is Record<string, unknown> & MeasurementResponsePayload {
  if (!isSessionPayload(value)) return false
  if (!isInteger(value.current) || value.current < 0) return false
  if (!isInteger(value.total) || value.total < 1 || value.total > 256 || value.current > value.total) return false
  if (value.left === null && value.right === null) return false
  return (value.left === null || isMeasurementResponseChannel(value.left))
    && (value.right === null || isMeasurementResponseChannel(value.right))
}

function isDbArray(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length === 64
    && value.every(isFiniteNumber)
}

function isCalibrationPackageGainArray(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length === 64
    && value.every((gain) => isFiniteNumber(gain)
      && gain >= -CALIBRATION_PACKAGE_MAX_GAIN_DB
      && gain <= CALIBRATION_PACKAGE_MAX_GAIN_DB)
}

function isCalibrationPackageFrequencyArray(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length !== 64) return false
  for (let index = 0; index < value.length; index++) {
    const frequency = value[index]
    if (!isFiniteNumber(frequency) || frequency <= 0) return false
    const previous = index > 0 ? value[index - 1] : undefined
    if (previous !== undefined && frequency <= previous) return false
  }
  return true
}

export function isCalibrationPackage(value: unknown): value is CalibrationPackage {
  if (!isRecord(value)
    || value.format !== CALIBRATION_PACKAGE_FORMAT
    || value.version !== CALIBRATION_PACKAGE_VERSION
    || !isFiniteNumber(value.exportedAt)
    || value.exportedAt <= 0
    || value.analysisRevision !== CALIBRATION_ANALYSIS_REVISION
    || typeof value.active !== 'boolean'
    || !isRecord(value.sourceDevice)
    || typeof value.sourceDevice.id !== 'string'
    || value.sourceDevice.id.length === 0
    || value.sourceDevice.id.length > 256
    || typeof value.sourceDevice.name !== 'string'
    || value.sourceDevice.name.length === 0
    || value.sourceDevice.name.length > 256
    || typeof value.sourceDevice.appVersion !== 'string'
    || value.sourceDevice.appVersion.length === 0
    || value.sourceDevice.appVersion.length > 64
    || (value.sourceDevice.buildId !== undefined
      && (typeof value.sourceDevice.buildId !== 'string'
        || value.sourceDevice.buildId.length === 0
        || value.sourceDevice.buildId.length > 128))
    || !isCalibrationPackageFrequencyArray(value.frequenciesHz)
    || !isCalibrationPackageGainArray(value.bandsDb)) return false

  const hasLeft = value.leftBandsDb !== undefined
  const hasRight = value.rightBandsDb !== undefined
  const hasEffectiveLeft = value.effectiveLeftBandsDb !== undefined
  const hasEffectiveRight = value.effectiveRightBandsDb !== undefined
  return hasLeft === hasRight
    && (!hasLeft || (isCalibrationPackageGainArray(value.leftBandsDb) && isCalibrationPackageGainArray(value.rightBandsDb)))
    && hasEffectiveLeft === hasEffectiveRight
    && (!hasEffectiveLeft || (isCalibrationPackageGainArray(value.effectiveLeftBandsDb) && isCalibrationPackageGainArray(value.effectiveRightBandsDb)))
    && (value.effectiveBandsDb === undefined || isCalibrationPackageGainArray(value.effectiveBandsDb))
}

function isProbeDbArray(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length === 64
    && value.every((band) => isFiniteNumber(band) && band >= -18 && band <= 6)
}

function isUserBandsPayload(value: unknown): value is SetBandsPayload {
  return isRecord(value)
    && Array.isArray(value.bandsDb)
    && value.bandsDb.length === 24
    && value.bandsDb.every((band) => isFiniteNumber(band) && band >= -15 && band <= 15)
}

function isCalibrationApplyPayload(value: unknown): value is CalibrationApplyPayload {
  if (!isRecord(value) || !isDbArray(value.bandsDb)) return false
  const hasLeft = value.leftBandsDb !== undefined
  const hasRight = value.rightBandsDb !== undefined
  return hasLeft === hasRight
    && (!hasLeft || (isDbArray(value.leftBandsDb) && isDbArray(value.rightBandsDb)))
}

function isProbeCurveApplyPayload(value: unknown): value is ProbeCurveApplyPayload {
  if (!isRecord(value)) return false
  if (value.curve !== undefined) return value.curve === 'flat' || value.curve === 'hollow'
  if (!isProbeDbArray(value.bandsDb)) return false
  const hasLeft = value.leftBandsDb !== undefined
  const hasRight = value.rightBandsDb !== undefined
  return hasLeft === hasRight
    && (!hasLeft || (isProbeDbArray(value.leftBandsDb) && isProbeDbArray(value.rightBandsDb)))
}

function isProbeRunPayload(value: unknown): value is ProbeRunPayload {
  return isRecord(value)
    && isInteger(value.bands)
    && value.bands >= 1
    && value.bands <= 128
}

function isPersistentProbePayload(value: unknown): value is PersistentProbePayload {
  return isRecord(value)
    && isInteger(value.bands)
    && value.bands === 64
}

function isCandidateActionPayload(value: unknown): value is CalibrationCandidateActionPayload {
  return isRecord(value)
    && typeof value.candidateId === 'string'
    && value.candidateId.length > 0
    && value.candidateId.length <= 128
}

function isCalibrationValidationResultPayload(value: unknown): value is CalibrationValidationResultPayload {
  if (!isCandidateActionPayload(value)) return false
  if (value.status === 'passed' || value.status === 'worse') {
    return isFiniteNumber(value.beforeDb)
      && isFiniteNumber(value.afterDb)
      && value.beforeDb >= 0
      && value.beforeDb <= 120
      && value.afterDb >= 0
      && value.afterDb <= 120
  }
  return (value.status === 'inconclusive' || value.status === 'failed')
    && typeof value.reason === 'string'
    && value.reason.length > 0
    && value.reason.length <= 512
}

export function isMeasurementSweep(value: unknown): value is MeasurementSweep {
  if (!isRecord(value)) return false
  if (value.sweepRevision !== CALIBRATION_SWEEP_REVISION) return false
  if (value.algorithm !== 'exponential-sine-v1') return false
  if (!isMeasurementCaptureKind(value.captureKind)) return false
  if (value.markerChannel !== 'left' && value.markerChannel !== 'right') return false
  if (!isFiniteNumber(value.sampleRate) || !Number.isInteger(value.sampleRate)) return false
  if (value.sampleRate < 8_000 || value.sampleRate > 192_000) return false
  if (!isFiniteNumber(value.startHz) || value.startHz <= 0) return false
  if (!isFiniteNumber(value.endHz) || value.endHz <= value.startHz) return false
  if (value.endHz > value.sampleRate / 2) return false
  if (!isFiniteNumber(value.durationMs) || value.durationMs <= 0 || value.durationMs > 120_000) return false
  if (!isFiniteNumber(value.preRollMs) || value.preRollMs < 0 || value.preRollMs > 60_000) return false
  if (!isFiniteNumber(value.postRollMs) || value.postRollMs < 0 || value.postRollMs > 60_000) return false
  if (!isFiniteNumber(value.syncMarkerStartHz) || value.syncMarkerStartHz <= 0) return false
  if (!isFiniteNumber(value.syncMarkerEndHz) || value.syncMarkerEndHz <= value.syncMarkerStartHz) return false
  if (value.syncMarkerEndHz >= value.sampleRate / 2) return false
  if (!isFiniteNumber(value.syncMarkerDurationMs) || value.syncMarkerDurationMs <= 0 || value.syncMarkerDurationMs > 1_000) return false
  if (!isFiniteNumber(value.syncMarkerGapMs) || value.syncMarkerGapMs < 0 || value.syncMarkerGapMs > 1_000) return false
  if (!isFiniteNumber(value.endMarkerStartHz) || value.endMarkerStartHz <= 0) return false
  if (!isFiniteNumber(value.endMarkerEndHz) || value.endMarkerEndHz <= 0 || value.endMarkerEndHz === value.endMarkerStartHz) return false
  if (Math.max(value.endMarkerStartHz, value.endMarkerEndHz) >= value.sampleRate / 2) return false
  if (!isFiniteNumber(value.endMarkerDurationMs) || value.endMarkerDurationMs <= 0 || value.endMarkerDurationMs > 1_000) return false
  if (!isFiniteNumber(value.interSweepGapMs) || value.interSweepGapMs < 0 || value.interSweepGapMs > 1_000) return false
  if (value.preRollMs < value.syncMarkerDurationMs + value.syncMarkerGapMs) return false
  if (!isFiniteNumber(value.sweepLevelDbfs) || value.sweepLevelDbfs > 0 || value.sweepLevelDbfs < -120) return false
  if (!isFiniteNumber(value.markerLevelDbfs) || value.markerLevelDbfs > 0 || value.markerLevelDbfs < -120) return false
  if (!isFiniteNumber(value.fadeInMs) || value.fadeInMs < 0 || value.fadeInMs > value.durationMs) return false
  if (!isFiniteNumber(value.fadeOutMs) || value.fadeOutMs < 0 || value.fadeOutMs > value.durationMs) return false
  return value.fadeInMs + value.fadeOutMs <= value.durationMs
}

export function isEnvelope(value: unknown): value is Envelope<unknown> {
  if (!isRecord(value)) return false
  if (value.v !== PROTOCOL_VERSION) return false
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 256) return false
  if (typeof value.type !== 'string' || value.type.length === 0) return false
  if (!isFiniteNumber(value.ts)) return false
  if (!Object.hasOwn(value, 'payload')) return false
  const shapeValid = (value.replyTo === undefined || (typeof value.replyTo === 'string' && value.replyTo.length <= 256))
    && (value.transportSessionId === undefined
      || (typeof value.transportSessionId === 'string'
        && value.transportSessionId.length > 0
        && value.transportSessionId.length <= 128))
    && (value.expiresAt === undefined
      || (isFiniteNumber(value.expiresAt) && value.expiresAt > value.ts && value.expiresAt <= value.ts + 120_000))
  return shapeValid && isEnvelopeWithinSizeLimit(value)
}

function isSessionPayload(value: unknown): value is Record<string, unknown> & CalibrationSessionPayload {
  return isRecord(value)
    && isSessionId(value.sessionId)
    && (value.channel === undefined || isCalibrationChannel(value.channel))
    && (value.phase === undefined || isMeasurementPhase(value.phase))
}

function isCandidateId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function isEmptyPayload(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0
}

function isProfileNamePayload(value: unknown): boolean {
  return isRecord(value)
    && typeof value.name === 'string'
    && value.name.trim().length > 0
    && value.name.length <= 128
}

function isPresetPayload(value: unknown): boolean {
  return isRecord(value) && isInteger(value.preset) && value.preset >= 0 && value.preset <= 128
}

function isProbeDiagnosticsPayload(value: unknown): boolean {
  if (!isRecord(value)
    || typeof value.running !== 'boolean'
    || typeof value.available !== 'boolean'
    || !isInteger(value.highest)
    || !isInteger(value.recommended)
    || !Array.isArray(value.results)
    || value.results.length > 128) return false
  return value.results.every((entry) => isRecord(entry)
    && isInteger(entry.requested)
    && entry.requested >= 1
    && entry.requested <= 128
    && typeof entry.constructed === 'boolean'
    && typeof entry.hasControl === 'boolean'
    && typeof entry.enabled === 'boolean'
    && isInteger(entry.actualBands)
    && entry.actualBands >= 0
    && typeof entry.pass === 'boolean')
}

function isDiagnosticDeviceInfoPayload(value: unknown): boolean {
  if (!isRecord(value)) return false
  const numericFields = [
    'javaHeapMax',
    'javaHeapTotal',
    'javaHeapFree',
    'nativeHeapAllocated',
    'nativeHeapSize',
    'pssTotalKb',
    'privateDirtyKb',
    'sharedDirtyKb',
    'cpuPercent',
    'audioserverCpuPercent',
    'persistentProbeBands',
  ]
  return numericFields.every((field) => isFiniteNumber(value[field]))
    && (value.audioserverPid === null || isInteger(value.audioserverPid))
    && typeof value.persistentProbeActive === 'boolean'
}

function isTransportDiagnosticsPayload(value: unknown): value is TransportDiagnosticsPayload {
  if (!isRecord(value)
    || typeof value.state !== 'string'
    || !['idle', 'pairing', 'signaling', 'connecting', 'direct', 'reconnecting', 'failed', 'closed'].includes(value.state)
    || (value.sessionId !== null && !isBoundedText(value.sessionId, 128))
    || (value.iceConnectionState !== null && !isBoundedText(value.iceConnectionState, 64))
    || (value.iceGatheringState !== null && !isBoundedText(value.iceGatheringState, 64))
    || (value.peerConnectionState !== null && !isBoundedText(value.peerConnectionState, 64))
    || (value.selectedCandidateType !== null && !isBoundedText(value.selectedCandidateType, 64))
    || (value.selectedCandidateProtocol !== null && !isBoundedText(value.selectedCandidateProtocol, 64))
    || (value.rttMs !== null && !isFiniteNumber(value.rttMs))
    || !isNonNegativeSafeInteger(value.bytesSent)
    || !isNonNegativeSafeInteger(value.bytesReceived)
    || !isNonNegativeSafeInteger(value.captureBufferedBytes)
    || !isNonNegativeSafeInteger(value.reconnectCount)
    || (value.signalingRoundTripMs !== null && !isFiniteNumber(value.signalingRoundTripMs))
    || (value.lastControlMessageAt !== null && !isNonNegativeSafeInteger(value.lastControlMessageAt))
    || (value.lastPeerTrafficAt !== null && !isNonNegativeSafeInteger(value.lastPeerTrafficAt))
    || (value.lastError !== null && !isBoundedText(value.lastError, 2_048))) return false
  return true
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && value >= 0
}

function isSessionWithChannel(value: unknown): value is Record<string, unknown> & CalibrationSessionBeginPayload {
  if (!isSessionPayload(value) || !isCalibrationChannel(value.channel)) return false
  if (value.phase !== undefined && !isMeasurementPhase(value.phase)) return false
  if (value.candidateId !== undefined && !isCandidateId(value.candidateId)) return false
  return (value.phase ?? 'measurement') === 'measurement'
    ? value.candidateId === undefined
    : value.candidateId !== undefined
}

function isSessionWithSweep(value: unknown): value is Record<string, unknown> & MeasurementReadyPayload {
  return isSessionPayload(value)
    && isMeasurementSweep(value.sweep)
    && (value.context === undefined || isMeasurementContext(value.context))
}

function isSessionWithOptionalContext(value: unknown): value is Record<string, unknown> & MeasurementPlaySweepPayload {
  return isSessionPayload(value)
    && (value.context === undefined || isMeasurementContext(value.context))
}

function isCalibrationSessionOutcome(value: unknown): value is CalibrationSessionOutcome {
  return value === 'sufficient'
    || value === 'bounded'
    || value === 'insufficient'
    || value === 'cancelled'
    || value === 'error'
}

function isCalibrationSessionEndPayload(value: unknown): value is Record<string, unknown> & CalibrationSessionEndPayload {
  return isSessionPayload(value) && isCalibrationSessionOutcome(value.outcome)
}

export function isCalibrationSessionEndedPayload(value: unknown): value is Record<string, unknown> & CalibrationSessionEndedPayload {
  return isSessionPayload(value)
    && isCalibrationSessionOutcome(value.outcome)
    && isSessionId(value.completedSessionId)
    && value.completedSessionId === value.sessionId
}

function isMeasurementPreparePayload(value: unknown): boolean {
  return isSessionWithChannel(value)
    && (value.context === undefined || isMeasurementContext(value.context))
}

export function isCalibrationSessionPositionContinuedPayload(value: unknown): value is CalibrationSessionPositionContinuedPayload {
  return isSessionPayload(value) && isMeasurementContext(value.context)
}

export function isMeasurementReadyPayload(value: unknown): value is MeasurementReadyPayload {
  return isSessionWithSweep(value)
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function isUniquePositionList(value: unknown): value is CalibrationPositionId[] {
  return Array.isArray(value)
    && value.length <= 5
    && value.every(isCalibrationPositionId)
    && new Set(value).size === value.length
}

const MANDATORY_CALIBRATION_POSITIONS: readonly CalibrationPositionId[] = ['center', 'left', 'right']

function isCalibrationJobPhase(value: unknown): value is CalibrationJobPhase {
  return value === 'center_preflight'
    || value === 'measuring_required'
    || value === 'usable'
    || value === 'refining'
    || value === 'candidate_pending'
    || value === 'validating'
    || value === 'reoptimizing'
    || value === 'restoring'
    || value === 'complete'
    || value === 'failed'
    || value === 'cancelled'
}

function isCalibrationUsabilityGrade(value: unknown): value is CalibrationUsabilityGrade {
  return value === 'bounded_usable' || value === 'sufficient'
}

function isCalibrationCorrectionMode(value: unknown): value is CalibrationCorrectionMode {
  return value === 'normal' || value === 'gentle' || value === 'restricted_band'
}

function isCalibrationValidationState(value: unknown): value is CalibrationValidationState {
  return value === 'none'
    || value === 'pending'
    || value === 'rolling_back'
    || value === 'passed'
    || value === 'worse'
    || value === 'inconclusive'
    || value === 'failed'
}

function isCalibrationConfidenceView(value: unknown): value is CalibrationConfidenceView {
  if (!isRecord(value)) return false
  return isInteger(value.usableBandCount)
    && value.usableBandCount >= 0
    && value.usableBandCount <= 64
    && value.totalBandCount === 64
    && isFiniteNumber(value.score)
    && value.score >= 0
    && value.score <= 1
    && (value.grade === null || isCalibrationUsabilityGrade(value.grade))
}

function isCalibrationSolutionView(value: unknown): value is CalibrationSolutionView {
  if (!isRecord(value)) return false
  return isBoundedText(value.solutionId, 128)
    && isUniquePositionList(value.sourcePositionIds)
    && value.sourcePositionIds.length > 0
    && isCalibrationConfidenceView(value.confidence)
    && isFiniteNumber(value.score)
    && value.score >= 0
    && value.score <= 1
    && isCalibrationCorrectionMode(value.correctionMode)
}

function isCalibrationNextAction(value: unknown): value is CalibrationNextAction {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'capture') {
    if (!isBoundedText(value.captureId, 128)
      || !isCalibrationPositionId(value.positionId)
      || (value.channel !== 'left' && value.channel !== 'right')
      || !isInteger(value.attemptIndex)
      || value.attemptIndex < 0
      || value.attemptIndex >= 2
      || typeof value.optional !== 'boolean'
      || !isBoundedText(value.instruction, 1024)) return false
    return value.optional === (value.positionId === 'forward' || value.positionId === 'backward')
  }
  if (value.kind === 'validate') {
    return isBoundedText(value.captureId, 128)
      && value.positionId === 'center'
      && isBoundedText(value.candidateId, 128)
      && isInteger(value.attemptIndex)
      && value.attemptIndex >= 0
      && value.attemptIndex < 2
      && isBoundedText(value.instruction, 1024)
  }
  if (value.kind === 'wait') return isBoundedText(value.message, 1024)
  if (value.kind === 'complete') return isBoundedText(value.solutionId, 128)
  return false
}

function isCalibrationJobErrorView(value: unknown): value is CalibrationJobErrorView {
  return isRecord(value)
    && isBoundedText(value.code, 128)
    && isBoundedText(value.message, 1024)
}

export function isCalibrationJobView(value: unknown): value is CalibrationJobView {
  if (!isRecord(value)) return false
  if (!isBoundedText(value.jobId, 128)
    || !isFiniteNumber(value.createdAtMs)
    || value.createdAtMs <= 0
    || !isInteger(value.revision)
    || value.revision < 0
    || !isBoundedText(value.analyzerRevision, 128)
    || !isBoundedText(value.sweepRevision, 128)
    || (value.mode !== 'auto' && value.mode !== 'advanced')
    || !isCalibrationJobPhase(value.phase)
    || !isUniquePositionList(value.acceptedPositions)
    || !isUniquePositionList(value.excludedPositions)
    || value.acceptedPositions.some((position) => value.excludedPositions.includes(position))
    || !isInteger(value.historicalAttemptCount)
    || value.historicalAttemptCount < 0
    || value.historicalAttemptCount > 256
    || !isInteger(value.optionalFailureCount)
    || value.optionalFailureCount < 0
    || value.optionalFailureCount > value.historicalAttemptCount
    || typeof value.minimumViableCalibration !== 'boolean'
    || !isCalibrationValidationState(value.validationState)) return false
  if (value.bestSolution !== null && !isCalibrationSolutionView(value.bestSolution)) return false
  if (value.confidence !== null && !isCalibrationConfidenceView(value.confidence)) return false
  if (value.nextAction !== null && !isCalibrationNextAction(value.nextAction)) return false
  if (value.activeCandidateId !== null && !isBoundedText(value.activeCandidateId, 128)) return false
  if (value.lastError !== null && !isCalibrationJobErrorView(value.lastError)) return false
  if (value.minimumViableCalibration
    && !MANDATORY_CALIBRATION_POSITIONS.every((position) => value.acceptedPositions.includes(position))) return false
  if (value.bestSolution !== null
    && (!MANDATORY_CALIBRATION_POSITIONS.every((position) => value.bestSolution.sourcePositionIds.includes(position))
      || !value.bestSolution.sourcePositionIds.every((position) => value.acceptedPositions.includes(position)))) return false
  if (value.bestSolution !== null
    && (value.confidence === null
      || value.bestSolution.confidence.usableBandCount !== value.confidence.usableBandCount
      || value.bestSolution.confidence.score !== value.confidence.score
      || value.bestSolution.confidence.grade !== value.confidence.grade)) return false
  return value.minimumViableCalibration === (value.bestSolution !== null)
}

function isCalibrationJobStartPayload(value: unknown): value is CalibrationJobStartPayload {
  return isRecord(value)
    && (value.mode === undefined || value.mode === 'auto' || value.mode === 'advanced')
}

function isCalibrationJobGetPayload(value: unknown): value is CalibrationJobGetPayload {
  return isRecord(value)
    && (value.jobId === undefined || isBoundedText(value.jobId, 128))
}

function isCalibrationJobIdPayload(value: unknown): value is CalibrationJobIdPayload {
  return isRecord(value) && isBoundedText(value.jobId, 128)
}

function isCalibrationJobCancelPayload(value: unknown): value is CalibrationJobCancelPayload {
  if (!isCalibrationJobIdPayload(value)) return false
  if (value.scope !== 'capture' && value.scope !== 'optional_refinement') return false
  if (value.scope === 'capture') return isBoundedText(value.captureId, 128)
    && (value.captureAttemptId === undefined || isBoundedText(value.captureAttemptId, 128))
  return value.captureId === undefined
}

function isCalibrationCaptureIdPayload(value: unknown): value is CalibrationCaptureReadyPayload {
  return isCalibrationJobIdPayload(value)
    && isBoundedText(value.captureId, 128)
    && isBoundedText(value.captureAttemptId, 128)
}

function isCalibrationCaptureChannel(value: unknown): value is CalibrationCaptureChannel {
  return value === 'left' || value === 'right' || value === 'both'
}

function isCalibrationCaptureSettings(value: unknown): value is CalibrationCaptureSettings {
  return isRecord(value)
    && (value.echoCancellation === null || typeof value.echoCancellation === 'boolean')
    && (value.noiseSuppression === null || typeof value.noiseSuppression === 'boolean')
    && (value.autoGainControl === null || typeof value.autoGainControl === 'boolean')
}

function isCalibrationMicrophoneProfilePayload(value: unknown): value is CalibrationMicrophoneProfilePayload {
  if (!isRecord(value)
    || !isBoundedText(value.id, 128)
    || !isBoundedText(value.revision, 128)
    || (value.capturePathStatus !== 'validated'
      && value.capturePathStatus !== 'provisional'
      && value.capturePathStatus !== 'unvalidated')
    || !Array.isArray(value.frequenciesHz)
    || !Array.isArray(value.responseDb)
    || value.frequenciesHz.length < 2
    || value.frequenciesHz.length > 512
    || value.frequenciesHz.length !== value.responseDb.length
    || !value.frequenciesHz.every((frequency) => isFiniteNumber(frequency)
      && frequency >= CALIBRATION_MIC_PROFILE_MIN_FREQUENCY_HZ
      && frequency <= CALIBRATION_MIC_PROFILE_MAX_FREQUENCY_HZ)
    || !value.responseDb.every((response) => isFiniteNumber(response)
      && Math.abs(response) <= CALIBRATION_MIC_PROFILE_MAX_RESPONSE_DB)
    || !isFiniteNumber(value.normalizeAtHz)
    || !isFiniteNumber(value.trustMinHz)
    || !isFiniteNumber(value.trustFullMaxHz)
    || !isFiniteNumber(value.trustTaperToHz)
    || !(value.trustMinHz >= CALIBRATION_MIC_PROFILE_MIN_FREQUENCY_HZ
      && value.trustMinHz <= CALIBRATION_MIC_PROFILE_MAX_FREQUENCY_HZ
      && value.trustFullMaxHz >= CALIBRATION_MIC_PROFILE_MIN_FREQUENCY_HZ
      && value.trustFullMaxHz <= CALIBRATION_MIC_PROFILE_MAX_FREQUENCY_HZ
      && value.trustTaperToHz >= CALIBRATION_MIC_PROFILE_MIN_FREQUENCY_HZ
      && value.trustTaperToHz <= CALIBRATION_MIC_PROFILE_MAX_FREQUENCY_HZ
      && value.trustMinHz < value.trustFullMaxHz
      && value.trustFullMaxHz < value.trustTaperToHz)
    || value.normalizeAtHz < value.frequenciesHz[0]
    || value.normalizeAtHz > value.frequenciesHz[value.frequenciesHz.length - 1]) return false
  for (let index = 1; index < value.frequenciesHz.length; index++) {
    if (value.frequenciesHz[index] <= value.frequenciesHz[index - 1]) return false
  }
  return true
}

function isCalibrationCaptureMetadata(value: unknown): value is CalibrationCaptureMetadata {
  if (!isRecord(value)) return false
  if (!isBoundedText(value.jobId, 128)
    || !isBoundedText(value.captureId, 128)
    || !isCalibrationPositionId(value.positionId)
    || !isInteger(value.attemptIndex)
    || value.attemptIndex < 0
    || value.attemptIndex >= 2
    || !isCalibrationCaptureChannel(value.channel)
    || !isInteger(value.sampleRate)
    || value.sampleRate < 8_000
    || value.sampleRate > 192_000
    || value.channelCount !== 1
    || !isInteger(value.sampleCount)
    || value.sampleCount <= 0
    || value.sampleCount > Math.floor(MAX_CALIBRATION_CAPTURE_BYTES / 4)
    || !isInteger(value.byteCount)
    || value.byteCount !== value.sampleCount * 4
    || !isCalibrationCaptureSettings(value.settings)
    || !isBoundedText(value.userAgent, 512)
    || !isBoundedText(value.microphoneProfileId, 128)
    || !isBoundedText(value.microphoneProfileRevision, 128)
    || !isCalibrationMicrophoneProfilePayload(value.microphoneProfile)
    || value.microphoneProfile.id !== value.microphoneProfileId
    || value.microphoneProfile.revision !== value.microphoneProfileRevision
    || !isFiniteNumber(value.capturedAtMs)
    || value.capturedAtMs <= 0) return false
  return true
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

export function isCalibrationCaptureFrameMetadata(value: unknown): value is CalibrationCaptureFrameMetadata {
  return isCalibrationCaptureMetadata(value) && isSha256(value.contentSha256)
}

export function isCalibrationCaptureUploadedPayload(value: unknown): value is CalibrationCaptureUploadedPayload {
  if (!isRecord(value)
    || !isBoundedText(value.jobId, 128)
    || !isBoundedText(value.captureId, 128)
    || !isBoundedText(value.captureAttemptId, 128)
    || !isSha256(value.contentSha256)
    || !isInteger(value.sampleCount)
    || value.sampleCount <= 0
    || value.sampleCount > Math.floor(MAX_CALIBRATION_CAPTURE_BYTES / 4)
    || !isInteger(value.byteCount)
    || value.byteCount !== value.sampleCount * 4
    || (value.status !== 'accepted' && value.status !== 'rejected' && value.status !== 'duplicate')) return false
  return value.reason === undefined || isBoundedText(value.reason, 1024)
}

function isCalibrationCaptureRejectedPayload(value: unknown): value is CalibrationCaptureRejectedPayload {
  return isRecord(value)
    && isBoundedText(value.jobId, 128)
    && isBoundedText(value.captureId, 128)
    && isBoundedText(value.captureAttemptId, 128)
    && isBoundedText(value.reason, 1_024)
}

function isCalibrationCaptureFinishedPayload(value: unknown): value is CalibrationCaptureFinishedPayload {
  return isCalibrationCaptureIdPayload(value)
}

function isCalibrationCaptureStartedPayload(value: unknown): value is CalibrationCaptureStartedPayload {
  return isCalibrationCaptureIdPayload(value)
}

export function isCalibrationCaptureWindowPayload(value: unknown): value is CalibrationCaptureWindowPayload {
  return isRecord(value)
    && isBoundedText(value.captureId, 128)
    && isBoundedText(value.captureAttemptId, 128)
    && isNonNegativeSafeInteger(value.nextSequence)
    && isInteger(value.windowSize)
    && value.windowSize >= 1
    && value.windowSize <= 32
}

function isCalibrationValidationCaptureReadyPayload(value: unknown): value is CalibrationValidationCaptureReadyPayload {
  return isCalibrationCaptureIdPayload(value)
    && isBoundedText(value.candidateId, 128)
}

function isAbortPayload(value: unknown): value is Record<string, unknown> & CalibrationSessionAbortPayload {
  return isSessionPayload(value)
    && isCalibrationErrorCode(value.code)
    && hasOptionalMessage(value)
}

export function validatePayload(type: string, payload: unknown): string | null {
  switch (type) {
    case 'ping':
    case 'pong':
    case 'state.get':
    case 'engine.enable':
    case 'engine.bypass':
    case 'virtualizer.on':
    case 'virtualizer.off':
    case 'profile.list':
    case 'calibration.get':
    case 'calibration.reset':
    case 'calibration.export':
    case 'probe.persistent.release':
      return isEmptyPayload(payload) ? null : `${type} requires an empty request payload`
    case 'calibration.job.start':
      return isCalibrationJobStartPayload(payload) ? null : `${type} requires a valid calibration mode`
    case 'calibration.job.get':
      return isCalibrationJobGetPayload(payload) ? null : `${type} requires an optional job id`
    case 'calibration.job.cancel':
      return isCalibrationJobCancelPayload(payload) ? null : `${type} requires a job id and valid cancel scope`
    case 'calibration.job.discard':
    case 'calibration.job.finish':
      return isCalibrationJobIdPayload(payload) ? null : `${type} requires a job id`
    case 'calibration.capture.ready':
      return isCalibrationCaptureIdPayload(payload) ? null : `${type} requires a job id and capture id`
    case 'calibration.validation.capture.ready':
      return isCalibrationValidationCaptureReadyPayload(payload)
        ? null
        : `${type} requires a job id, capture id, and candidate id`
    case 'engine.applyPreset':
      return isPresetPayload(payload) ? null : `${type} requires a valid preset id`
    case 'profile.save':
    case 'profile.load':
    case 'profile.delete':
      return isProfileNamePayload(payload) ? null : `${type} requires a bounded profile name`
    case 'diagnostics.deviceInfo':
      return isEmptyPayload(payload) || isDiagnosticDeviceInfoPayload(payload)
        ? null
        : `${type} requires an empty request or valid device diagnostics`
    case 'probe.status':
      return isEmptyPayload(payload) || isProbeDiagnosticsPayload(payload)
        ? null
        : `${type} requires an empty request or valid probe diagnostics`
    case 'probe.result':
      return isProbeDiagnosticsPayload(payload) ? null : `${type} requires valid probe diagnostics`
    case 'diagnostics.effects':
    case 'diagnostics.probe':
      return isEmptyPayload(payload)
        || (isRecord(payload) && Array.isArray(payload.inventory) && Array.isArray(payload.sessionProbes))
        ? null
        : `${type} requires an empty request or valid effect diagnostics`
    case 'diagnostics.transport':
      return isEmptyPayload(payload) || isTransportDiagnosticsPayload(payload)
        ? null
        : `${type} requires an empty request or valid transport diagnostics`
    case 'state.snapshot':
    case 'state.changed':
      return isStateSnapshot(payload) ? null : `${type} requires a valid state snapshot`
    case 'engine.setBands':
      return isUserBandsPayload(payload) ? null : `${type} requires 24 finite bands within ±15 dB`
    case 'calibrationSession.begin':
      return isSessionWithChannel(payload) ? null : `${type} requires sessionId and channel`
    case 'measurement.prepare':
      return isMeasurementPreparePayload(payload) ? null : `${type} requires sessionId, channel, and an optional valid context`
    case 'probe.run':
      return isProbeRunPayload(payload) ? null : `${type} requires a band count from 1 to 128`
    case 'probe.persistent.start':
      return isPersistentProbePayload(payload) ? null : `${type} requires exactly 64 diagnostic bands`
    case 'probe.curve.apply':
      return isProbeCurveApplyPayload(payload) ? null : `${type} requires a named curve or 64 diagnostic bands within -18 to +6 dB`
    case 'calibrationSession.loudness.start':
    case 'calibrationSession.loudness.stop':
      return isSessionPayload(payload) ? null : `${type} requires sessionId`
    case 'calibrationSession.progress':
      return isProgressPayload(payload) ? null : `${type} requires a valid calibration progress payload`
    case 'calibrationSession.end':
    case 'diagnostics.calibrationSession.end':
      return isCalibrationSessionEndPayload(payload) ? null : `${type} requires sessionId and a final outcome`
    case 'measurement.abort':
    case 'calibrationSession.started':
      return isSessionPayload(payload) ? null : `${type} requires sessionId`
    case 'calibrationSession.ended':
      return isCalibrationSessionEndedPayload(payload) ? null : `${type} requires sessionId and a final outcome`
    case 'calibrationSession.position.continued':
      return isCalibrationSessionPositionContinuedPayload(payload)
        ? null
        : `${type} requires sessionId and a valid measurement context`
    case 'measurement.playSweep':
    case 'measurement.finished':
      return isSessionWithOptionalContext(payload) ? null : `${type} requires sessionId and a valid optional context`
    case 'measurement.diagnostics':
      return isMeasurementDiagnosticsPayload(payload) ? null : `${type} requires compact diagnostics and a valid context`
    case 'measurement.response':
      return isMeasurementResponsePayload(payload) ? null : `${type} requires a compact finite response curve`
    case 'calibrationSession.abort':
      return isAbortPayload(payload) ? null : `${type} requires sessionId and a valid code`
    case 'calibration.applyCandidate':
      return isCalibrationApplyPayload(payload) ? null : `${type} requires 64 finite bands and optional paired channel curves`

    case 'calibration.import':
      return isCalibrationPackage(payload) ? null : `${type} requires a valid SweetSpot calibration package`
    case 'calibration.acceptCandidate':
    case 'calibration.rollbackCandidate':
      return isCandidateActionPayload(payload) ? null : `${type} requires a candidateId`
    case 'calibration.validation.result':
      return isCalibrationValidationResultPayload(payload) ? null : `${type} requires a candidateId and a valid validation result`
    case 'calibration.exported':
      return isCalibrationPackage(payload) ? null : `${type} requires a valid SweetSpot calibration package`
    case 'calibration.capture.uploaded':
      return isCalibrationCaptureUploadedPayload(payload) ? null : `${type} requires a valid upload result`
    case 'calibration.capture.rejected':
      return isCalibrationCaptureRejectedPayload(payload) ? null : `${type} requires a job, capture, and reason`
    case 'calibration.capture.finished':
      return isCalibrationCaptureFinishedPayload(payload) ? null : `${type} requires a job id and capture id`
    case 'calibration.capture.started':
      return isCalibrationCaptureStartedPayload(payload) ? null : `${type} requires a job id and capture id`
    case 'calibration.capture.window':
      return isCalibrationCaptureWindowPayload(payload) ? null : `${type} requires a capture id and valid receive window`
    case 'calibration.job.state':
      return isCalibrationJobView(payload) ? null : `${type} requires a valid calibration job view`
    case 'measurement.ready':
    case 'measurement.started':
      return isSessionWithSweep(payload) ? null : `${type} requires sessionId and sweep`
    case 'calibrationSession.loudness.started':
      return isLoudnessStartedPayload(payload) ? null : `${type} requires a valid loudness descriptor`
    case 'calibrationSession.loudness.stopped':
      return isSessionPayload(payload) ? null : `${type} requires sessionId`
    case 'measurement.error':
      return isSessionPayload(payload)
        && isCalibrationErrorCode(payload.code)
        && hasOptionalMessage(payload)
        ? null
        : `${type} requires sessionId and a valid code`
    default:
      return `${type} has no payload validator`
  }
}

export function isValidPayload(type: string, payload: unknown): boolean {
  return validatePayload(type, payload) === null
}
