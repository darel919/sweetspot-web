<template>
  <div class="page connect-page">
    <div :inert="calibrationLocked" :aria-hidden="calibrationLocked ? 'true' : undefined">
      <ConnectHeaderStatus :status="status" :toast-message="toastMessage" />

      <section v-if="codeError" class="block">
        <p class="error">INVALID PAIR CODE. Scan the QR code on your TV again.</p>
      </section>

      <template v-else>
        <ConnectDeviceSection
          :room="room"
          :device-online="deviceOnline"
          :snapshot="snapshot"
        />

        <ConnectEqualizerSection
          v-if="snapshot"
          :snapshot="snapshot"
          :presets="presets"
          :eq-draft="eqDraft"
          :eq-dirty="eqDirty"
          :profile-name="profileName"
          @band-input="onBandInput"
          @commit-bands="commitBands"
          @reset-bands="resetBands"
          @set-engine="setEngine"
          @apply-preset="applyPreset"
          @update-profile-name="profileName = $event"
          @save-profile="saveProfile"
          @load-profile="loadProfile"
          @delete-profile="deleteProfile"
        />

        <ConnectCalibrationSection
          v-if="snapshot"
          :snapshot="snapshot"
          :measurement-stage="measurementStage"
          :measurement-busy="measurementBusy"
          :measurement-message="measurementMessage"
          :measurement-analysis="measurementAnalysis"
          :measurement-records="measurementRecords"
          :measurement-aggregate-left="measurementAggregateLeft"
          :measurement-aggregate-right="measurementAggregateRight"
          :measurement-validation-analysis="measurementValidationAnalysis"
          :measurement-repeatability-passed="measurementRepeatabilityPassed"
          :measurement-failed-groups="measurementFailedGroups"
          :measurement-current-position="measurementCurrentPosition"
          :measurement-progress="measurementProgress"
          :measurement-capture-info="measurementCaptureInfo"
          :measurement-failed-diagnostics="measurementFailedDiagnostics"
          :measurement-profiles="measurementProfiles"
          :measurement-selected-profile-id="measurementSelectedProfileId"
          :measurement-profile-error="measurementProfileError"
          :recommended-correction="recommendedCorrection"
          :correction-strength="correctionStrength"
          :correction-strength-options="correctionStrengthOptions"
          :correction-pending="correctionPending"
          :calibration-applied="calibrationApplied"
          :calibration-finalization-pending="calibrationFinalizationPending"
          :calibration-result="calibrationResult"
          :calibration-result-message="calibrationResultMessage"
          :rollback-available="candidateTransaction !== null"
          :validation-worse="validationWorse"
          :candidate-pending="candidateTransaction !== null"
          :candidate-validation-status="candidateTransaction?.validationStatus ?? null"
          :validation-ready="validationReady"
          :cal-json="calJson"
          :cal-status="calStatus"
          :validation-metrics="validationMetrics"
          @select-profile="measurementSelectedProfileId = $event"
          @select-strength="correctionStrength = $event"
          @edit-curve="calJson = $event"
          @start-measurement="startMeasurement"
          @cancel-measurement="cancelCalibration"
          @retry-failed-groups="retryFailedGroups"
          @start-validation="startValidation"
          @apply-recommended-correction="applyRecommendedCorrection"
          @apply-calibration="applyCalibration"
          @reset-calibration="resetCalibration"
          @rollback-calibration="rollbackCalibration"
          @accept-candidate="acceptCandidate"
        />

        <ConnectDiagnosticsSection
          v-if="snapshot"
          :diag-pending="diagPending"
          :probe="probe"
          :probe-pending="probePending"
          :persistent-state="persistentState"
          :probe-band="probeBand"
          :probe-gain-db="probeGainDb"
          :probe-lab-pending="probeLabPending"
          :probe-lab-message="probeLabMessage"
          :probe-evidence="probeEvidence"
          :virtualizer-on="virtualizerOn"
          :device-info="deviceInfo"
          :dev-info-pending="devInfoPending"
          @run-effects-diagnostics="runEffectsDiagnostics"
          @run-capacity-probe="runCapacityProbe"
          @set-probe-band="probeBand = $event"
          @set-probe-gain-db="probeGainDb = $event"
          @create-persistent="createPersistent"
          @release-persistent="releasePersistent"
          @apply-test-curve="applyTestCurve"
          @capture-transfer-probe="captureTransferProbe"
          @run-routing-probe="runRoutingProbe"
          @clear-probe-evidence="probeEvidence = []"
          @export-probe-evidence="exportProbeEvidence"
          @set-virtualizer="setVirtualizer"
          @fetch-device-info="fetchDeviceInfo"
        />

        <ConnectEffectChainSection
          v-if="effectsDiagnostics"
          :effects-diagnostics="effectsDiagnostics"
        />
        <ConnectStateSection
          v-else
          :status="status"
          @request-state="getState"
        />

        <ConnectDebugPanel v-if="debugLog.length" :entries="debugLog" />
        <ConnectFooter :version="snapshot?.device.appVersion ?? '—'" />
      </template>
    </div>

    <ConnectCalibrationOverlay
      v-if="calibrationLocked"
      :stage="calibrationOverlayStage"
      :message="calibrationOverlayMessage"
      :progress="measurementProgress"
      :estimated-remaining-seconds="measurementEstimatedRemainingSeconds"
      :can-cancel="canCancelCalibration"
      @cancel-measurement="cancelCalibration"
    />
  </div>
</template>

<script setup lang="ts">
import type {
  DeviceInfoPayload,
  EffectsDiagnostics,
  PersistentProbeState,
  PresetOption,
  ProbeDiagnostics,
  StateSnapshot,
  CalibrationTransaction,
  CalibrationApplyPayload,
} from '#shared/types/protocol'
import { CALIBRATION_VALIDATION_WORSE_TOLERANCE_DB, isStateSnapshot } from '#shared/types/protocol'
import { calculateCorrection, combineChannelAggregates, targetErrorRms, type CorrectionStrength } from '~/lib/audio/correction/optimizer'
import { mapCorrectionToBandsConservative } from '~/lib/audio/correction/bandMapper'
import { targetPointsFor } from '~/lib/audio/correction/target'
import { isMicCalibrationProfileEligibleForCorrection } from '~/lib/audio/mics/profile'
import { shouldNotifyOffline } from '~/composables/connectionState'
import { useScreenWakeLock } from '~/composables/useScreenWakeLock'
import { onMounted, onScopeDispose, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import '~/components/connect/connect.css'
import ConnectCalibrationSection from '~/components/connect/ConnectCalibrationSection.vue'
import ConnectCalibrationOverlay from '~/components/connect/ConnectCalibrationOverlay.vue'
import ConnectDebugPanel from '~/components/connect/ConnectDebugPanel.vue'
import ConnectDeviceSection from '~/components/connect/ConnectDeviceSection.vue'
import ConnectDiagnosticsSection from '~/components/connect/ConnectDiagnosticsSection.vue'
import ConnectEffectChainSection from '~/components/connect/ConnectEffectChainSection.vue'
import ConnectEqualizerSection from '~/components/connect/ConnectEqualizerSection.vue'
import ConnectFooter from '~/components/connect/ConnectFooter.vue'
import ConnectHeaderStatus from '~/components/connect/ConnectHeaderStatus.vue'
import ConnectStateSection from '~/components/connect/ConnectStateSection.vue'
import { isCalibrationActiveStage } from '~/composables/useCalibrationSession'
import {
  classifyCalibrationValidation,
  shouldStartAutomaticValidation,
  type CalibrationValidationOutcome,
} from '~/lib/audio/correction/calibration-validation'
import {
  canIssueStandaloneCandidateRollback,
  formatCalibrationAbortCompletion,
  formatCalibrationAbortRecoveryFailure,
  isAbortRecoveryActive,
  shouldKeepCalibrationLockedDuringAbort,
  shouldReportValidationFailure,
} from '~/lib/audio/correction/calibration-recovery'
import { shouldStageAutomaticCorrection } from '~/lib/audio/correction/calibration-staging'
import {
  assessSharedLfReproduction,
  blendSharedLfCorrections,
  DEFAULT_SHARED_LF_POLICY,
} from '~/lib/audio/correction/shared-lf'
import type {
  AggregateResponse,
} from '~/lib/audio/measurement/aggregation'
import { allRepeatabilityPassed } from '~/lib/audio/measurement/aggregation'
import { EqCommandRevisionGate } from '~/lib/eq-command-revision'
import type {
  CalibrationResultStatus,
  CalibrationValidationMetrics,
  CorrectionStrengthOption,
  ProbeCaptureEvidence,
  RecommendedCorrection,
} from '~/components/connect/types'

const route = useRoute()

const rawCode = computed(() => String(route.params.code ?? ''))
const codeValid = computed(() => /^[A-Za-z0-9]{6,10}$/.test(rawCode.value.replace(/-/g, '')))
const codeError = computed(() => !codeValid.value)
const room = computed(() => rawCode.value.toUpperCase())

const connection = useSweetSpotConnection('client', () => rawCode.value)
const { status, deviceOnline, debugLog, connect, send, request, onMessage } = connection
const {
  stage: measurementStage,
  message: measurementMessage,
  analysis: measurementAnalysis,
  records: measurementRecords,
  aggregateLeft: measurementAggregateLeft,
  aggregateRight: measurementAggregateRight,
  aggregateBoth: measurementAggregateBoth,
  validationAnalysis: measurementValidationAnalysis,
  validationActive: measurementValidationActive,
  validationAggregateLeft: measurementValidationAggregateLeft,
  validationAggregateRight: measurementValidationAggregateRight,
  repeatabilityPassed: measurementRepeatabilityPassed,
  failedRepeatabilityGroups: measurementFailedGroups,
  currentPosition: measurementCurrentPosition,
  progress: measurementProgress,
  estimatedRemainingSeconds: measurementEstimatedRemainingSeconds,
  captureInfo: measurementCaptureInfo,
  failedTakeDiagnostics: measurementFailedDiagnostics,
  profiles: measurementProfiles,
  selectedProfileId: measurementSelectedProfileId,
  profileError: measurementProfileError,
  loadProfiles: loadMeasurementProfiles,
  start: startMeasurementSession,
  startValidation: startValidationSession,
  startProbe: startProbeSession,
  retryFailedGroups,
  validationFailed: measurementValidationFailed,
  validationCandidateId: measurementValidationCandidateId,
  completedMeasurementId: measurementCompletedId,
  abortRecovery: measurementAbortRecovery,
  cancel: cancelMeasurement,
  observeAbortRecoverySnapshot,
} = useCalibrationSession({
  send: connection.send,
  onMessage: connection.onMessage,
  isDeviceOnline: () => deviceOnline.value,
})
const snapshot = ref<StateSnapshot | null>(null)
const candidateTransaction = computed<Extract<CalibrationTransaction, { state: 'candidate_pending' }> | null>(() => {
  const transaction = snapshot.value?.calibration.transaction
  return transaction?.state === 'candidate_pending' ? transaction : null
})
const automaticValidationCandidateId = ref<string | null>(null)
const automaticStagingMeasurementId = ref<string | null>(null)
const automaticStagingFailedMeasurementId = ref<string | null>(null)
const correctionPending = ref(false)
const measurementBusy = computed(() => isCalibrationActiveStage(measurementStage.value))
let stateSnapshotRevision = 0
let recoverySnapshotBaselineRevision = 0
let recoveryIdentity = ''

watch(measurementAbortRecovery, (recovery) => {
  const nextIdentity = isAbortRecoveryActive(recovery.state)
    ? `${recovery.state}:${recovery.details.sessionId}:${recovery.details.candidateId ?? ''}:${recovery.details.code}`
    : ''
  if (nextIdentity === recoveryIdentity) return
  recoveryIdentity = nextIdentity
  recoverySnapshotBaselineRevision = stateSnapshotRevision
}, { immediate: true, flush: 'sync' })

const calibrationFinalization = ref<{
  candidateId: string
  outcome: ValidationDecision
  phase: 'reporting' | 'accepting' | 'rolling-back'
  errorMessage: string | null
} | null>(null)
const calibrationFinalizationPending = computed(() =>
  calibrationFinalization.value !== null
    && calibrationFinalization.value.errorMessage === null,
)
const validationAbortRecoveryError = computed(() => {
  const recovery = measurementAbortRecovery.value
  return recovery.state === 'failed'
    ? formatCalibrationAbortRecoveryFailure(recovery.failure)
    : null
})
const validationAbortRecoveryPending = computed(() => shouldKeepCalibrationLockedDuringAbort({
  abortState: measurementAbortRecovery.value.state,
  transactionState: snapshot.value?.calibration.transaction.state ?? null,
  liveDspStatus: snapshot.value?.calibration.liveDspStatus ?? null,
}) && validationAbortRecoveryError.value === null)
const automaticCalibrationPending = computed(() => {
  if (calibrationFinalization.value?.errorMessage || validationAbortRecoveryError.value) {
    return correctionPending.value || measurementValidationActive.value
  }
  const transaction = candidateTransaction.value
  const automaticCandidate = transaction?.state === 'candidate_pending'
    && ((automaticStagingMeasurementId.value !== null
      && automaticStagingMeasurementId.value === measurementCompletedId.value
      && automaticStagingFailedMeasurementId.value !== measurementCompletedId.value)
      || automaticValidationCandidateId.value === transaction.candidateId)
  return correctionPending.value || measurementValidationActive.value || automaticCandidate
})
const calibrationLocked = computed(() =>
  measurementBusy.value
    || calibrationFinalizationPending.value
    || validationAbortRecoveryPending.value
    || automaticCalibrationPending.value,
)
const canCancelCalibration = computed(() => {
  if (validationAbortRecoveryPending.value) return false
  if (measurementBusy.value) return true
  const finalization = calibrationFinalization.value
  const transaction = snapshot.value?.calibration.transaction
  const sameCandidate = transaction?.state === 'candidate_pending'
    && transaction.candidateId === finalization?.candidateId
  return sameCandidate && (finalization?.errorMessage !== null || finalization?.phase === 'reporting')
})
const calibrationOverlayStage = computed(() =>
  calibrationFinalizationPending.value || validationAbortRecoveryPending.value || automaticCalibrationPending.value
    ? 'ending'
    : measurementStage.value,
)
const calibrationOverlayMessage = computed(() => {
  if (validationAbortRecoveryPending.value) {
    return measurementAbortRecovery.value.state === 'pending'
      ? 'The TV is restoring the previous calibration.'
      : 'The TV is confirming the final calibration state.'
  }
  if (automaticCalibrationPending.value) {
    if (correctionPending.value) return 'The TV is staging the recommended correction.'
    return 'Validation will continue automatically. Follow the instructions on the TV.'
  }
  const finalization = calibrationFinalization.value
  if (!finalization) return measurementMessage.value
  if (finalization.errorMessage) return finalization.errorMessage
  if (finalization.phase === 'reporting') return 'Validation complete. Finalizing the calibration result.'
  return finalization.phase === 'accepting'
    ? 'Validation improved. Saving the calibration.'
    : 'Restoring the previous calibration.'
})
const screenWakeLock = useScreenWakeLock()
const toastMessage = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
let eqRevisionTimer: ReturnType<typeof setTimeout> | null = null
let restoreScrollLock: (() => void) | null = null
let beforeUnloadAttached = false

function preventCalibrationUnload(event: BeforeUnloadEvent) {
  event.preventDefault()
  event.returnValue = ''
}

function syncCalibrationLock(locked: boolean) {
  if (!import.meta.client) return
  screenWakeLock.setActive(locked)
  if (locked && restoreScrollLock === null) {
    const bodyOverflow = document.body.style.overflow
    const documentOverflow = document.documentElement.style.overflow
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'
    restoreScrollLock = () => {
      document.body.style.overflow = bodyOverflow
      document.documentElement.style.overflow = documentOverflow
    }
  }
  if (locked && !beforeUnloadAttached) {
    window.addEventListener('beforeunload', preventCalibrationUnload)
    beforeUnloadAttached = true
  }
  if (!locked) {
    restoreScrollLock?.()
    restoreScrollLock = null
    if (beforeUnloadAttached) {
      window.removeEventListener('beforeunload', preventCalibrationUnload)
      beforeUnloadAttached = false
    }
  }
}

watch(calibrationLocked, syncCalibrationLock, { immediate: true })
onBeforeRouteLeave(() => calibrationLocked.value ? false : undefined)
onBeforeRouteUpdate((to, from) => {
  if (calibrationLocked.value && to.fullPath !== from.fullPath) return false
})

const eqCommandRevision = new EqCommandRevisionGate()
let eqDraftRevision = 0
let eqSentRevision = 0
const effectsDiagnostics = ref<EffectsDiagnostics | null>(null)
const diagPending = ref(false)

const probe = ref<ProbeDiagnostics | null>(null)
const probePending = ref(false)
const persistentState = ref<PersistentProbeState | null>(null)
const probeBand = ref<number | string>(32)
const probeGainDb = ref<number | string>(-6)
const probeLabPending = ref(false)
const probeLabMessage = ref('')
const probeEvidence = ref<ProbeCaptureEvidence[]>([])
const ROUTING_TEST_BANDS = [4, 20, 36, 52] as const

const deviceInfo = ref<DeviceInfoPayload | null>(null)
const devInfoPending = ref(false)

const calJson = ref('')
const calStatus = ref('')
const calIsError = ref(false)
const profileName = ref('')
const calibrationApplied = ref(false)
const calibrationResult = ref<CalibrationResultStatus | null>(null)
const calibrationResultMessage = ref('')
const correctionStrength = ref<CorrectionStrength>('normal')
const correctionStrengthOptions: readonly CorrectionStrengthOption[] = [
  { id: 'gentle', label: 'Gentle' },
  { id: 'normal', label: 'Normal' },
  { id: 'strong', label: 'Strong' },
]

function mappedCorrectionSummary(curves: readonly number[]): {
  maxCutDb: number
  maxBoostDb: number
  headroomDb: number
} {
  const maxCutDb = Math.min(...curves)
  const maxBoostDb = Math.max(...curves)
  return {
    maxCutDb,
    maxBoostDb,
    headroomDb: maxBoostDb > 0 ? -(maxBoostDb + 0.5) : 0,
  }
}

const recommendedCorrection = computed<RecommendedCorrection | null>(() => {
  const currentSnapshot = snapshot.value
  const profile = measurementProfiles.value.find((candidate) => candidate.id === measurementSelectedProfileId.value)
  if (!currentSnapshot || !profile) return null
  const bandCutoffs = currentSnapshot.calibration.frequenciesHz
  if (bandCutoffs.length !== 64) return null
  if (measurementStage.value !== 'complete' || !measurementRepeatabilityPassed.value) return null
  if (currentSnapshot.capabilities.supportsCalibratedCorrection !== true) return null
  if (!isMicCalibrationProfileEligibleForCorrection(profile)) return null
  const headroomVerified = currentSnapshot.capabilities.supportsHeadroomCompensation === true
  const independent = currentSnapshot.capabilities.supportsIndependentCalibration === true
    && measurementAggregateLeft.value !== null
    && measurementAggregateRight.value !== null
  const commonAggregate = measurementAggregateBoth.value
    ?? (measurementAggregateLeft.value && measurementAggregateRight.value
      ? combineChannelAggregates(measurementAggregateLeft.value, measurementAggregateRight.value)
      : null)
  if (!commonAggregate) return null
  if (commonAggregate.points.length < 2) return null

  const common = calculateCorrection(commonAggregate, profile, {
    strength: correctionStrength.value,
    headroomVerified,
  })
  if (!independent || !measurementAggregateLeft.value || !measurementAggregateRight.value) {
    const commonBands = mapCorrectionToBandsConservative(common.correction, bandCutoffs)
    return {
      bandsDb: commonBands,
      independent: false,
      ...mappedCorrectionSummary(commonBands),
      lfExtension3DbHz: common.lfExtension3DbHz,
      lfExtension6DbHz: common.lfExtension6DbHz,
      lfExtensionConfidence: common.lfExtensionConfidence,
    }
  }
  const left = calculateCorrection(measurementAggregateLeft.value, profile, { strength: correctionStrength.value, headroomVerified })
  const right = calculateCorrection(measurementAggregateRight.value, profile, { strength: correctionStrength.value, headroomVerified })
  const sharedLfCurves = blendSharedLfCorrections(common.correction, left.correction, right.correction)
  const commonBands = mapCorrectionToBandsConservative(common.correction, bandCutoffs)
  const leftBandsDb = mapCorrectionToBandsConservative(sharedLfCurves.left, bandCutoffs)
  const rightBandsDb = mapCorrectionToBandsConservative(sharedLfCurves.right, bandCutoffs)
  const channelSummary = mappedCorrectionSummary([...leftBandsDb, ...rightBandsDb])
  return {
    bandsDb: commonBands,
    leftBandsDb,
    rightBandsDb,
    independent: true,
    sharedLf: {
      ...DEFAULT_SHARED_LF_POLICY,
      assessment: assessSharedLfReproduction(measurementAggregateLeft.value, measurementAggregateRight.value),
    },
    ...channelSummary,
  }
})

const validationAggregate = computed<AggregateResponse | null>(() => {
  if (!measurementValidationAggregateLeft.value || !measurementValidationAggregateRight.value) return null
  if (!allRepeatabilityPassed(measurementValidationAggregateLeft.value)
    || !allRepeatabilityPassed(measurementValidationAggregateRight.value)) return null
  return combineChannelAggregates(measurementValidationAggregateLeft.value, measurementValidationAggregateRight.value)
})

const validationBaselineReady = computed(() => {
  const left = measurementAggregateLeft.value
  const right = measurementAggregateRight.value
  const center = measurementAggregateBoth.value?.positionResponses.find((response) => response.positionId === 'center')
  return left !== null
    && right !== null
    && allRepeatabilityPassed(left)
    && allRepeatabilityPassed(right)
    && center !== undefined
    && center.points.length >= 2
})

const selectedMeasurementProfile = computed(() =>
  measurementProfiles.value.find((profile) => profile.id === measurementSelectedProfileId.value) ?? null,
)
const validationCapturePathEligible = computed(() =>
  selectedMeasurementProfile.value !== null
  && isMicCalibrationProfileEligibleForCorrection(selectedMeasurementProfile.value),
)

const validationMetrics = computed<CalibrationValidationMetrics | null>(() => {
  if (!validationBaselineReady.value) return null
  const before = measurementAggregateBoth.value?.positionResponses.find((response) => response.positionId === 'center')
  const after = validationAggregate.value?.positionResponses.find((response) => response.positionId === 'center')
  if (!before || !after) return null
  const target = targetPointsFor(before.points)
  return { before: targetErrorRms(before.points, target), after: targetErrorRms(after.points, target) }
})

const validationWorse = computed(() => {
  if (candidateTransaction.value?.validationStatus === 'worse') return true
  const metrics = validationMetrics.value
  return metrics !== null && metrics.after > metrics.before + CALIBRATION_VALIDATION_WORSE_TOLERANCE_DB
})

const deviceValidationReady = computed(() => {
  const current = snapshot.value
  return current !== null
    && current.calibration.active
    && current.calibration.transaction.state === 'candidate_pending'
    && current.calibration.transaction.validationStatus === 'pending'
    && current.calibration.applicationVerified === true
    && current.calibration.liveDspStatus === 'verified'
    && current.calibration.headroomVerified === true
})

const validationReady = computed(() =>
  validationBaselineReady.value
  && deviceValidationReady.value
  && validationCapturePathEligible.value,
)

const validationOutcome = computed(() => {
  const transaction = candidateTransaction.value
  if (measurementStage.value !== 'complete' || !transaction || transaction.validationStatus !== 'pending') return null
  if (measurementValidationCandidateId.value !== transaction.candidateId) return null
  const validationRepeatable = measurementValidationAggregateLeft.value !== null
    && measurementValidationAggregateRight.value !== null
    && allRepeatabilityPassed(measurementValidationAggregateLeft.value)
    && allRepeatabilityPassed(measurementValidationAggregateRight.value)
  return classifyCalibrationValidation({
    beforeDb: validationMetrics.value?.before ?? null,
    afterDb: validationMetrics.value?.after ?? null,
    baselineRepeatable: validationBaselineReady.value,
    validationRepeatable,
  })
})

const validationOutcomeKey = computed(() => {
  const outcome = validationOutcome.value
  if (!outcome || !candidateTransaction.value) return null
  return JSON.stringify({ candidateId: candidateTransaction.value.candidateId, ...outcome })
})
type ValidationDecision = CalibrationValidationOutcome | { status: 'error'; reason: string }

const sentValidationOutcomeKeys = new Set<string>()
let validationResultInFlight = false

onMounted(() => {
  void loadMeasurementProfiles().catch(() => undefined)
})

function showToast(message: string) {
  toastMessage.value = message
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastMessage.value = ''
    toastTimer = null
  }, 5000)
}

watch([status, deviceOnline], ([nextStatus, nextOnline], [previousStatus, previousOnline]) => {
  if (shouldNotifyOffline(
    { status: previousStatus, deviceOnline: previousOnline },
    { status: nextStatus, deviceOnline: nextOnline },
  )) {
    showToast('The TV connection is offline. Changes will not apply.')
  }
})

onScopeDispose(() => {
  if (toastTimer !== null) clearTimeout(toastTimer)
  if (eqRevisionTimer !== null) clearTimeout(eqRevisionTimer)
  if (persistentState.value?.active) send('probe.persistent.release')
  syncCalibrationLock(false)
  screenWakeLock.dispose()
})

onMessage((env) => {
  if (env.type !== 'state.snapshot') return
  if (!eqCommandRevision.shouldApply(env.replyTo)) return
  if (env.replyTo !== undefined) {
    eqCommandRevision.settle(env.replyTo)
    if (eqRevisionTimer !== null) clearTimeout(eqRevisionTimer)
    eqRevisionTimer = null
  }
  if (typeof env.payload === 'object' && env.payload !== null && 'ok' in env.payload && env.payload.ok === false) {
    const error = 'error' in env.payload && typeof env.payload.error === 'string' ? env.payload.error : 'live DSP rejected the change'
    showToast(`TV rejected the change: ${error}`)
  }
  if (!isStateSnapshot(env.payload)) {
    showToast('The TV sent an invalid state snapshot. Calibration controls are paused.')
    return
  }
  const next: StateSnapshot = env.payload
  stateSnapshotRevision += 1
  const recoveryActive = isAbortRecoveryActive(measurementAbortRecovery.value.state)
  const recoveryObservation = observeAbortRecoverySnapshot({
    authoritative: recoveryActive && stateSnapshotRevision > recoverySnapshotBaselineRevision,
    transaction: next.calibration.transaction,
    liveDspStatus: next.calibration.liveDspStatus ?? null,
    applicationError: next.calibration.applicationError ?? null,
  })
  if (JSON.stringify(next) !== JSON.stringify(snapshot.value)) snapshot.value = next
  if (recoveryObservation.kind === 'completed') applyAbortRecoveryCompletion(recoveryObservation.details)
})

const eqDraft = ref<number[]>([])

watch(snapshot, (s) => {
  if (!s) return
  calibrationApplied.value = s.calibration.active
  if (eqDraftRevision === eqSentRevision) eqDraft.value = [...s.userEq.bandsDb]
  if (!calJson.value.trim()) {
    calJson.value = JSON.stringify(s.calibration.bandsDb.map((v) => Math.round(v * 10) / 10))
  }
})

function candidateMatches(candidateId: string): boolean {
  return candidateTransaction.value?.candidateId === candidateId
}

function validationPayload(candidateId: string, outcome: ValidationDecision) {
  if (outcome.status === 'improved') {
    return { candidateId, status: 'passed' as const, beforeDb: outcome.beforeDb, afterDb: outcome.afterDb }
  }
  if (outcome.status === 'worse') {
    return { candidateId, status: 'worse' as const, beforeDb: outcome.beforeDb, afterDb: outcome.afterDb }
  }
  if (outcome.status === 'inconclusive') {
    return { candidateId, status: 'inconclusive' as const, reason: outcome.reason }
  }
  return { candidateId, status: 'failed' as const, reason: outcome.reason }
}

function setFinalizationError(candidateId: string, message: string) {
  const current = calibrationFinalization.value
  if (!current || current.candidateId !== candidateId) return
  if (!candidateMatches(candidateId)) calibrationFinalization.value = null
  else calibrationFinalization.value = { ...current, errorMessage: message }
  calibrationResult.value = 'error'
  calibrationResultMessage.value = message
  calIsError.value = true
  calStatus.value = message
}

function retryFinalizationRollback() {
  const current = calibrationFinalization.value
  if (!current || current.errorMessage === null || !candidateMatches(current.candidateId)) return
  const outcome: ValidationDecision = { status: 'error', reason: current.errorMessage }
  calibrationFinalization.value = {
    ...current,
    outcome,
    phase: 'rolling-back',
    errorMessage: null,
  }
  void performCandidateFinalization(current.candidateId)
}

function cancelCalibration() {
  const finalization = calibrationFinalization.value
  if (finalization && candidateMatches(finalization.candidateId)) {
    if (finalization.errorMessage !== null) {
      retryFinalizationRollback()
      return
    }
    if (finalization.phase !== 'reporting') return
    const outcome: ValidationDecision = { status: 'error', reason: 'Calibration cancelled before finalization.' }
    calibrationFinalization.value = {
      ...finalization,
      outcome,
      phase: 'rolling-back',
    }
    void performCandidateFinalization(finalization.candidateId)
    return
  }
  cancelMeasurement()
}

function validationStatusMatchesOutcome(
  status: string,
  outcome: ValidationDecision,
): boolean {
  if (outcome.status === 'improved') return status === 'passed'
  if (outcome.status === 'worse') return status === 'worse'
  if (outcome.status === 'inconclusive') return status === 'inconclusive'
  return status === 'failed'
}

function completeFinalizationIfReady() {
  const current = calibrationFinalization.value
  const currentSnapshot = snapshot.value
  if (!current || !currentSnapshot || currentSnapshot.calibration.transaction.state !== 'none') return

  const readbackVerified = currentSnapshot.calibration.liveDspStatus === 'verified'
  if (current.errorMessage || !readbackVerified) {
    calibrationResult.value = 'error'
    calibrationResultMessage.value = current.errorMessage ?? 'The TV completed the transaction without verified DSP readback.'
    calIsError.value = true
    calStatus.value = calibrationResultMessage.value
  } else if (current.outcome.status === 'improved') {
    calibrationResult.value = 'improved'
    calibrationResultMessage.value = `Target error improved from ${current.outcome.beforeDb.toFixed(2)} to ${current.outcome.afterDb.toFixed(2)} dB RMS.`
    calIsError.value = false
    calStatus.value = 'Calibration candidate accepted automatically.'
  } else if (current.outcome.status === 'worse') {
    calibrationResult.value = 'worse'
    calibrationResultMessage.value = 'The candidate was worse than the baseline. Previous settings were restored.'
    calIsError.value = false
    calStatus.value = calibrationResultMessage.value
  } else if (current.outcome.status === 'inconclusive') {
    calibrationResult.value = 'inconclusive'
    calibrationResultMessage.value = 'The candidate could not be proven better. Previous settings were restored.'
    calIsError.value = false
    calStatus.value = calibrationResultMessage.value
  } else {
    calibrationResult.value = 'error'
    calibrationResultMessage.value = `Validation failed. Previous settings were restored. ${current.outcome.reason}`
    calIsError.value = true
    calStatus.value = calibrationResultMessage.value
  }
  calibrationApplied.value = currentSnapshot.calibration.active
  calibrationFinalization.value = null
}

function showAbortRecoveryError(message: string) {
  calibrationResult.value = 'error'
  calibrationResultMessage.value = message
  calIsError.value = true
  calStatus.value = message
  showToast(message)
}

function applyAbortRecoveryCompletion(details: Parameters<typeof formatCalibrationAbortCompletion>[0]) {
  const result = formatCalibrationAbortCompletion(details)
  calibrationResult.value = result.kind === 'cancelled' ? 'cancelled' : 'error'
  calibrationResultMessage.value = result.message
  calIsError.value = result.kind !== 'cancelled'
  calStatus.value = result.message
  if (result.kind === 'validation-failure') showToast(result.message)
}

let reportedAbortRecoveryFailure = ''
watch(measurementAbortRecovery, (recovery) => {
  if (recovery.state === 'idle') {
    reportedAbortRecoveryFailure = ''
    return
  }
  if (recovery.state !== 'failed') return
  const message = formatCalibrationAbortRecoveryFailure(recovery.failure)
  const key = JSON.stringify(recovery)
  if (key === reportedAbortRecoveryFailure) return
  reportedAbortRecoveryFailure = key
  showAbortRecoveryError(message)
})

async function performCandidateFinalization(candidateId: string) {
  const current = calibrationFinalization.value
  if (!current || current.candidateId !== candidateId || current.phase === 'reporting' || measurementAbortRecovery.value.state !== 'idle') return
  if (!candidateMatches(candidateId)) {
    setFinalizationError(candidateId, 'The pending candidate changed before finalization. Recovery is required.')
    return
  }
  const type = current.phase === 'accepting'
    ? 'calibration.acceptCandidate'
    : 'calibration.rollbackCandidate'
  const response = await withTimeout(request(type, { candidateId }), 15_000)
  if (!response) {
    setFinalizationError(candidateId, `The TV did not answer while ${current.phase === 'accepting' ? 'accepting' : 'rolling back'} the candidate. The transaction remains recoverable.`)
    return
  }
  const action = stateActionResult(response.payload)
  if (action.snapshot) snapshot.value = action.snapshot
  if (!action.ok) {
    setFinalizationError(candidateId, `The TV could not ${current.phase === 'accepting' ? 'accept' : 'roll back'} the candidate. ${action.error ?? 'The transaction remains recoverable.'}`)
    return
  }
  if (action.snapshot?.calibration.transaction.state === 'none') {
    completeFinalizationIfReady()
    return
  }
  void waitForFinalization(candidateId)
}

async function waitForFinalization(candidateId: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const current = calibrationFinalization.value
    if (!current || current.candidateId !== candidateId || current.errorMessage !== null) return
    completeFinalizationIfReady()
    if (!calibrationFinalization.value) return
    const stateReply = await withTimeout(request('state.get'), 2_000)
    if (stateReply && isStateSnapshot(stateReply.payload)) snapshot.value = stateReply.payload
    completeFinalizationIfReady()
    if (!calibrationFinalization.value) return
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  setFinalizationError(candidateId, 'The TV did not confirm the final calibration transaction. Recovery is required.')
}

function beginCandidateFinalization(
  candidateId: string,
  outcome: ValidationDecision,
  forceRollback = false,
  errorMessage: string | null = null,
) {
  if (!candidateMatches(candidateId)) {
    const message = 'The candidate changed before finalization. Recovery is required.'
    const current = calibrationFinalization.value
    if (current?.candidateId === candidateId) calibrationFinalization.value = null
    calibrationResult.value = 'error'
    calibrationResultMessage.value = message
    calIsError.value = true
    calStatus.value = message
    return
  }
  // Only a metrics-proven improvement is accepted; inconclusive and worse outcomes restore the baseline.
  const phase = forceRollback || outcome.status !== 'improved' ? 'rolling-back' as const : 'accepting' as const
  const current = calibrationFinalization.value
  if (current?.candidateId === candidateId) {
    if (current.phase !== 'reporting') return
    calibrationFinalization.value = { ...current, outcome, phase, errorMessage }
    void performCandidateFinalization(candidateId)
    return
  }
  calibrationFinalization.value = { candidateId, outcome, phase, errorMessage }
  void performCandidateFinalization(candidateId)
}

async function sendValidationResultOnce(candidateId: string, outcome: ValidationDecision, outcomeKey: string) {
  if (sentValidationOutcomeKeys.has(outcomeKey) || validationResultInFlight || measurementAbortRecovery.value.state !== 'idle') return
  if (!candidateMatches(candidateId) || measurementValidationCandidateId.value !== candidateId) return
  calibrationFinalization.value = {
    candidateId,
    outcome,
    phase: 'reporting',
    errorMessage: null,
  }
  validationResultInFlight = true
  try {
    const result = await withTimeout(request('calibration.validation.result', validationPayload(candidateId, outcome)), 15_000)
    const action = result ? stateActionResult(result.payload) : null
    if (action?.snapshot) snapshot.value = action.snapshot
    const recordedStatus = action?.snapshot?.calibration.transaction.state === 'candidate_pending'
      ? action.snapshot.calibration.transaction.validationStatus
      : null
    const alreadyRecorded = recordedStatus !== null && validationStatusMatchesOutcome(recordedStatus, outcome)
    if ((!result || !action?.ok) && !alreadyRecorded) {
      const reason = !result
        ? 'The TV did not answer while recording the validation result.'
        : 'The TV rejected the validation result.'
      beginCandidateFinalization(candidateId, outcome, true, `${reason} Previous settings will be restored. The transaction remains recoverable if rollback cannot finish.`)
      return
    }
    sentValidationOutcomeKeys.add(outcomeKey)
    beginCandidateFinalization(candidateId, outcome, outcome.status !== 'improved' || recordedStatus !== null && recordedStatus !== 'passed')
  } finally {
    validationResultInFlight = false
  }
}

watch(
  [measurementStage, measurementCompletedId, recommendedCorrection, measurementRepeatabilityPassed, deviceOnline, correctionPending, candidateTransaction],
  ([stage, measurementId, correction, repeatabilityPassed, online, applying, transaction]) => {
    const currentSnapshot = snapshot.value
    if (!shouldStageAutomaticCorrection({
      measurementComplete: stage === 'complete' && repeatabilityPassed,
      measurementId,
      correction,
      supportsCalibratedCorrection: currentSnapshot?.capabilities.supportsCalibratedCorrection === true,
      capturePathEligible: validationCapturePathEligible.value,
      deviceOnline: online,
      candidatePending: transaction !== null,
      applyInProgress: applying,
      attemptedMeasurementId: automaticStagingMeasurementId.value,
      failedMeasurementId: automaticStagingFailedMeasurementId.value,
    })) return
    if (!measurementId || !correction) return
    void stageRecommendedCorrectionAutomatically(measurementId, correction)
  },
  { immediate: true },
)

watch(
  [measurementStage, measurementCompletedId, validationBaselineReady, deviceValidationReady, validationCapturePathEligible, candidateTransaction, deviceOnline, measurementValidationActive, measurementAbortRecovery, automaticStagingFailedMeasurementId],
  ([stage, measurementId, baselineRepeatable, deviceReady, capturePathEligible, transaction, online, validationActive, abortRecovery, stagingFailedMeasurementId]) => {
    const candidateId = transaction?.validationStatus === 'pending' ? transaction.candidateId : null
    if (calibrationFinalizationPending.value || abortRecovery.state !== 'idle' || !shouldStartAutomaticValidation({
      measurementComplete: stage === 'complete',
      measurementId,
      candidateId,
      baselineRepeatable,
      deviceValidationReady: deviceReady,
      capturePathEligible,
      deviceOnline: online,
      validationActive,
      startedCandidateId: automaticValidationCandidateId.value,
      stagingFailedMeasurementId,
    })) return
    if (!candidateId) return
    automaticValidationCandidateId.value = candidateId
    calibrationResult.value = null
    calibrationResultMessage.value = ''
    startValidationSession(candidateId)
  },
  { immediate: true },
)

watch([measurementStage, validationOutcomeKey, deviceOnline], ([stage, outcomeKey]) => {
  if (stage !== 'complete' || !outcomeKey || validationResultInFlight) return
  const transaction = candidateTransaction.value
  const outcome = validationOutcome.value
  if (!transaction || !outcome || measurementValidationCandidateId.value !== transaction.candidateId) return
  void sendValidationResultOnce(transaction.candidateId, outcome, outcomeKey)
})

watch([measurementStage, measurementValidationFailed, measurementValidationCandidateId, candidateTransaction, deviceOnline, measurementAbortRecovery], ([stage, failed, candidateId, transaction, _online, abortRecovery]) => {
  if (stage !== 'error' || !shouldReportValidationFailure({
    validationFailed: failed,
    candidateMatches: candidateId !== null && transaction?.candidateId === candidateId,
    abortState: abortRecovery.state,
  }) || !candidateId || !transaction || transaction.candidateId !== candidateId) return
  const reason = measurementMessage.value || 'Validation measurement failed.'
  const outcome: ValidationDecision = { status: 'error', reason }
  void sendValidationResultOnce(candidateId, outcome, `${candidateId}:failed:${reason}`)
})

watch([measurementStage, measurementValidationFailed, measurementMessage], ([stage, failed, reason]) => {
  if (stage !== 'error' || !failed) return
  calibrationResult.value = 'error'
  calibrationResultMessage.value = reason || 'Validation measurement failed.'
  calIsError.value = true
  calStatus.value = calibrationResultMessage.value
})

watch([snapshot, deviceOnline], () => {
  completeFinalizationIfReady()
})

const presets = computed<PresetOption[]>(() => snapshot.value?.capabilities.presets ?? [])

const eqDirty = computed(() => {
  const cur = snapshot.value?.userEq.bandsDb ?? []
  return eqDraft.value.some((v, i) => Math.abs(v - (cur[i] ?? v)) > 1e-6)
})

function onBandInput(i: number, ev: Event) {
  const v = parseFloat((ev.target as HTMLInputElement).value)
  if (Number.isNaN(v)) return
  eqDraft.value[i] = v
  eqDraftRevision++
}

function commitBands() {
  setBands(eqDraft.value)
}

function resetBands() {
  const cur = snapshot.value?.userEq.bandsDb ?? []
  eqDraft.value = [...cur]
  eqDraftRevision = eqSentRevision
}

function setBands(bandsDb: number[]) {
  eqSentRevision = eqDraftRevision
  const commandId = send('engine.setBands', { bandsDb })
  eqCommandRevision.track(commandId)
  if (eqRevisionTimer !== null) clearTimeout(eqRevisionTimer)
  eqRevisionTimer = setTimeout(() => {
    eqCommandRevision.abandonPending()
    eqRevisionTimer = null
  }, 15_000)
}

function setEngine(enabled: boolean) {
  send(enabled ? 'engine.enable' : 'engine.bypass')
}

function applyPreset(preset: number) {
  send('engine.applyPreset', { preset })
}

function saveProfile() {
  const name = profileName.value.trim()
  if (!name) return
  send('profile.save', { name })
  profileName.value = ''
}

function loadProfile(name: string) {
  send('profile.load', { name })
}

function deleteProfile(name: string) {
  send('profile.delete', { name })
}

function parseCurve(text: string): number[] | null {
  try {
    const arr = JSON.parse(text)
    if (!Array.isArray(arr) || arr.length !== 64) return null
    const values = arr.map((v) => Number(v))
    return values.every(Number.isFinite) ? values : null
  } catch {
    return null
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))])
}

function responseWasAccepted(payload: unknown): boolean {
  return typeof payload === 'object'
    && payload !== null
    && 'ok' in payload
    && payload.ok === true
}

function stateActionResult(payload: unknown): { ok: boolean; snapshot: StateSnapshot | null; error: string | null } {
  const snapshot = isStateSnapshot(payload) ? payload : null
  const ok = responseWasAccepted(payload)
  const error = typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string'
    ? payload.error
    : null
  return { ok, snapshot, error }
}

function correctionPayload(correction: RecommendedCorrection): CalibrationApplyPayload {
  if (correction.independent && correction.leftBandsDb && correction.rightBandsDb) {
    return {
      bandsDb: correction.bandsDb,
      leftBandsDb: correction.leftBandsDb,
      rightBandsDb: correction.rightBandsDb,
    }
  }
  return { bandsDb: correction.bandsDb }
}

function automaticStagingFailure(measurementId: string, reason: string) {
  automaticStagingFailedMeasurementId.value = measurementId
  const message = `Automatic correction failed. ${reason} Recovery controls remain available. Automatic validation is blocked for this measurement.`
  calibrationResult.value = 'error'
  calibrationResultMessage.value = message
  calIsError.value = true
  calStatus.value = message
  showToast(message)
}

async function stageRecommendedCorrectionAutomatically(
  measurementId: string,
  correction: RecommendedCorrection,
) {
  if (automaticStagingMeasurementId.value === measurementId) return
  automaticStagingMeasurementId.value = measurementId
  correctionPending.value = true
  calibrationResult.value = null
  calibrationResultMessage.value = ''
  calIsError.value = false
  calStatus.value = 'Applying the recommended correction…'
  try {
    const response = await withTimeout(request('calibration.applyCandidate', correctionPayload(correction)), 15_000)
    if (!response) {
      automaticStagingFailure(measurementId, 'The TV did not answer within 15s.')
      return
    }
    const action = stateActionResult(response.payload)
    if (action.snapshot) {
      snapshot.value = action.snapshot
      calibrationApplied.value = action.snapshot.calibration.active
    }
    const candidateStaged = action.ok
      && action.snapshot?.calibration.transaction.state === 'candidate_pending'
      && action.snapshot.calibration.liveDspStatus === 'verified'
    if (!candidateStaged) {
      automaticStagingFailure(measurementId, 'The TV did not confirm a verified pending candidate.')
      return
    }
    calStatus.value = 'Correction staged. Validation will start automatically.'
    calJson.value = JSON.stringify((action.snapshot.calibration.requestedBandsDb ?? action.snapshot.calibration.bandsDb).map((value) => Math.round(value * 10) / 10))
  } catch (error: unknown) {
    automaticStagingFailure(measurementId, error instanceof Error ? error.message : 'The TV rejected the correction.')
  } finally {
    correctionPending.value = false
  }
}

async function applyCalibration() {
  if (snapshot.value?.capabilities.supportsCalibratedCorrection !== true) {
    calIsError.value = true
    calStatus.value = 'The TV has not characterized its calibration transfer functions.'
    return
  }
  if (!deviceOnline.value) {
    calIsError.value = true
    calStatus.value = 'The TV connection is offline. The candidate cannot apply.'
    return
  }
  const bandsDb = parseCurve(calJson.value)
  calIsError.value = bandsDb == null
  if (bandsDb == null) {
    calStatus.value = 'Need a JSON array of exactly 64 numbers.'
    return
  }
  calStatus.value = 'Applying…'
  const res = await withTimeout(request('calibration.applyCandidate', { bandsDb }), 15_000)
  if (!res) {
    calIsError.value = true
    calStatus.value = 'TV did not answer within 15s.'
    return
  }
  const action = stateActionResult(res.payload)
  const candidateStaged = action.snapshot?.calibration.transaction.state === 'candidate_pending'
    && action.snapshot.calibration.liveDspStatus === 'verified'
  calIsError.value = !action.ok || !candidateStaged
  calStatus.value = !action.ok || !candidateStaged
    ? 'Device rejected curve: ' + (action.error ?? 'invalid TV response')
    : 'Candidate applied. Validate it, accept it, or roll it back.'
  if (action.ok && action.snapshot) {
    snapshot.value = action.snapshot
    calibrationApplied.value = action.snapshot.calibration.active
  }
}

async function applyRecommendedCorrection() {
  const correction = recommendedCorrection.value
  if (measurementStage.value !== 'complete' || !correction || !measurementRepeatabilityPassed.value || correctionPending.value) return
  if (snapshot.value?.capabilities.supportsCalibratedCorrection !== true) {
    showToast('The TV has not characterized its calibration transfer functions.')
    return
  }
  if (!deviceOnline.value) {
    showToast('The TV connection is offline. The correction cannot apply.')
    return
  }
  correctionPending.value = true
  calStatus.value = 'Applying recommended correction…'
  try {
    const res = await withTimeout(request('calibration.applyCandidate', correctionPayload(correction)), 15_000)
    if (!res) {
      calIsError.value = true
      calStatus.value = 'TV did not answer within 15s.'
      return
    }
    const action = stateActionResult(res.payload)
    const candidateStaged = action.snapshot?.calibration.transaction.state === 'candidate_pending'
      && action.snapshot.calibration.liveDspStatus === 'verified'
    calIsError.value = !action.ok || !candidateStaged
    calStatus.value = !action.ok || !candidateStaged
      ? 'Device rejected correction: ' + (action.error ?? 'invalid TV response')
      : correction.independent
        ? 'Independent left/right correction applied.'
        : 'Common correction applied.'
    if (action.ok && action.snapshot) {
      snapshot.value = action.snapshot
      calibrationApplied.value = action.snapshot.calibration.active
      calJson.value = JSON.stringify((action.snapshot.calibration.requestedBandsDb ?? action.snapshot.calibration.bandsDb).map((value) => Math.round(value * 10) / 10))
    }
  } finally {
    correctionPending.value = false
  }
}

async function rollbackCalibration() {
  const transaction = candidateTransaction.value
  if (!canIssueStandaloneCandidateRollback({
    validationActive: measurementValidationActive.value,
    candidatePending: transaction !== null,
  }) || correctionPending.value) return
  correctionPending.value = true
  calStatus.value = 'Rolling back the last calibration…'
  try {
    const res = await withTimeout(request('calibration.rollbackCandidate', {
      candidateId: transaction.candidateId,
    }), 15_000)
    if (!res) {
      calIsError.value = true
      calStatus.value = 'TV did not answer within 15s.'
      return
    }
    const action = stateActionResult(res.payload)
    if (!action.ok || action.snapshot?.calibration.transaction.state !== 'none') {
      calIsError.value = true
      calStatus.value = 'TV rejected the rollback: ' + (action.error ?? 'invalid TV response')
      return
    }
    calibrationApplied.value = action.snapshot?.calibration.active ?? false
    calIsError.value = false
    calStatus.value = 'Previous calibration restored.'
  } finally {
    correctionPending.value = false
  }
}

async function acceptCandidate() {
  const transaction = candidateTransaction.value
  if (!transaction || correctionPending.value || measurementValidationActive.value) return
  correctionPending.value = true
  calStatus.value = 'Accepting the calibration candidate…'
  try {
    const res = await withTimeout(request('calibration.acceptCandidate', {
      candidateId: transaction.candidateId,
    }), 15_000)
    if (!res) {
      calIsError.value = true
      calStatus.value = 'TV did not answer within 15s.'
      return
    }
    const action = stateActionResult(res.payload)
    const accepted = action.ok
      && action.snapshot?.calibration.transaction.state === 'none'
      && action.snapshot.calibration.liveDspStatus === 'verified'
    calIsError.value = !accepted
    calStatus.value = !accepted
      ? 'TV rejected candidate acceptance: ' + (action.error ?? 'invalid TV response')
      : 'Calibration candidate accepted.'
  } finally {
    correctionPending.value = false
  }
}

async function resetCalibration() {
  if (measurementValidationActive.value) return
  calStatus.value = 'Resetting…'
  const transaction = candidateTransaction.value
  if (transaction) {
    const rollback = await withTimeout(request('calibration.rollbackCandidate', {
      candidateId: transaction.candidateId,
    }), 15_000)
    if (!rollback || !stateActionResult(rollback.payload).ok) {
      calIsError.value = true
      calStatus.value = 'TV could not roll back the pending candidate.'
      return
    }
  }
  const reset = await withTimeout(request('calibration.reset'), 15_000)
  const resetAction = reset ? stateActionResult(reset.payload) : null
  if (!resetAction?.ok || !resetAction.snapshot || resetAction.snapshot.calibration.active) {
    calIsError.value = true
    calStatus.value = 'TV could not verify the calibration reset.'
    return
  }
  calibrationApplied.value = false
  calStatus.value = 'Calibration reset.'
}

function getState() {
  request('state.get')
}

function startMeasurement() {
  if (!snapshot.value?.capabilities.supportsSweep) return
  if (correctionPending.value || measurementAbortRecovery.value.state !== 'idle') return
  if (!deviceOnline.value) {
    showToast('The TV connection is offline. Calibration cannot start.')
    return
  }
  calibrationApplied.value = false
  calibrationResult.value = null
  calibrationResultMessage.value = ''
  void startMeasurementSession()
}

function startValidation() {
  if (measurementAbortRecovery.value.state !== 'idle') {
    showToast('Resolve the pending validation recovery before starting another sweep.')
    return
  }
  if (!deviceOnline.value) {
    showToast('The TV connection is offline. Validation cannot start.')
    return
  }
  if (snapshot.value?.calibration.liveDspStatus !== 'verified') {
    showToast('The TV has not verified the live calibration state. Validation is blocked.')
    return
  }
  if (!deviceValidationReady.value) {
    showToast('Validation requires an active pending candidate, flat user EQ, verified headroom, and live DSP readback.')
    return
  }
  const candidateId = candidateTransaction.value?.candidateId
  if (!candidateId) {
    showToast('Validation requires a pending calibration candidate.')
    return
  }
  if (!validationBaselineReady.value) {
    showToast('Validation requires a repeatable center baseline from this browser session. Re-measure before validating.')
    return
  }
  calibrationResult.value = null
  calibrationResultMessage.value = ''
  startValidationSession(candidateId)
}

const virtualizerOn = ref(false)

async function setVirtualizer(on: boolean) {
  virtualizerOn.value = on
  await withTimeout(request('virtualizer.' + (on ? 'on' : 'off')), 10_000)
}

async function runEffectsDiagnostics() {
  if (diagPending.value) return
  diagPending.value = true
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 30_000))
  try {
    const res = await Promise.race([request<EffectsDiagnostics>('diagnostics.effects'), timeout])
    effectsDiagnostics.value = res ? (res.payload as EffectsDiagnostics) : { error: 'TV did not answer within 30s', inventory: [], sessionProbes: [] }
  } finally {
    diagPending.value = false
  }
}

async function refreshProbeState() {
  const res = await withTimeout(request<ProbeDiagnostics>('probe.status'), 20_000)
  if (res) {
    const p = res.payload as ProbeDiagnostics
    probe.value = { ...p }
    if (p.persistent) persistentState.value = p.persistent
  }
}

async function runCapacityProbe() {
  if (probePending.value) return
  probePending.value = true
  try {
    const res = await withTimeout(
      request<ProbeDiagnostics>('probe.run', { bands: 128 }),
      45_000,
    )
    if (res) {
      probe.value = res.payload as ProbeDiagnostics
      await refreshProbeState()
    }
  } finally {
    probePending.value = false
  }
}

async function createPersistent() {
  const bands = 64
  await withTimeout(request('probe.persistent.start', { bands }), 30_000)
  await refreshProbeState()
}

async function releasePersistent() {
  await withTimeout(request('probe.persistent.release'), 20_000)
  persistentState.value = { active: false, bands: 0, curve: null, curveSummary: null }
  await refreshProbeState()
}

async function applyTestCurve(curve: 'hollow' | 'flat') {
  await withTimeout(request('probe.curve.apply', { curve }), 20_000)
  await refreshProbeState()
}

function boundedProbeBand(): number {
  const input = typeof probeBand.value === 'number' ? probeBand.value : Number(probeBand.value)
  const band = Math.round(Number.isFinite(input) ? input : 32)
  const bounded = Math.max(1, Math.min(64, band))
  probeBand.value = bounded
  return bounded
}

function boundedProbeGain(): number {
  const input = typeof probeGainDb.value === 'number' ? probeGainDb.value : Number(probeGainDb.value)
  const gain = Number.isFinite(input) ? input : -6
  const bounded = Math.max(-6, Math.min(6, gain))
  probeGainDb.value = bounded
  return bounded
}

function probeCurve(channel: 'common' | 'left' | 'right', band: number, gainDb: number): Record<string, number[]> {
  const common = Array.from({ length: 64 }, () => 0)
  const selected = Array.from({ length: 64 }, () => 0)
  selected[band - 1] = gainDb
  if (channel === 'common') {
    common[band - 1] = gainDb
    return { bandsDb: common }
  }
  return {
    bandsDb: common,
    leftBandsDb: channel === 'left' ? selected : common,
    rightBandsDb: channel === 'right' ? selected : common,
  }
}

async function ensurePersistent64(): Promise<boolean> {
  if (persistentState.value?.active && persistentState.value.bands === 64) return true
  if (persistentState.value?.active) {
    await withTimeout(request('probe.persistent.release'), 20_000)
  }
  await withTimeout(request('probe.persistent.start', { bands: 64 }), 30_000)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await refreshProbeState()
    if (persistentState.value?.active && persistentState.value.bands === 64) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

function snapshotProbeEvidence(
  mode: 'transfer' | 'routing',
  cutChannel: 'common' | 'left' | 'right' | 'flat',
  bandIndex: number,
  gainDb: number,
  aggregate: AggregateResponse,
): ProbeCaptureEvidence {
  return {
    id: `probe_${Date.now().toString(36)}_${probeEvidence.value.length.toString(36)}`,
    mode,
    cutChannel,
    bandIndex,
    gainDb,
    repeatabilityPassed: allRepeatabilityPassed(aggregate),
    capturedAt: new Date().toISOString(),
    positionResponses: JSON.parse(JSON.stringify(aggregate.positionResponses)) as AggregateResponse['positionResponses'],
    repeatability: JSON.parse(JSON.stringify(aggregate.repeatability)) as AggregateResponse['repeatability'],
  }
}

async function captureProbeSweep(kind: 'transfer' | 'routing'): Promise<AggregateResponse> {
  const finished = new Promise<AggregateResponse>((resolve, reject) => {
    const stop = watch(measurementStage, (nextStage) => {
      if (nextStage === 'complete') {
        stop()
        const aggregate = measurementAggregateBoth.value
        if (aggregate) resolve(aggregate)
        else reject(new Error('The probe completed without a response aggregate.'))
      } else if (nextStage === 'error') {
        stop()
        reject(new Error(measurementMessage.value || 'The diagnostic probe failed.'))
      } else if (nextStage === 'idle') {
        stop()
        reject(new Error('The diagnostic probe was cancelled.'))
      }
    }, { immediate: true })
    startProbeSession(kind)
  })
  return finished
}

async function applyProbeCurvePayload(payload: Record<string, number[]>) {
  const response = await withTimeout(request('probe.curve.apply', payload), 20_000)
  if (!response || !responseWasAccepted(response.payload)) {
    throw new Error('The TV rejected the diagnostic curve. Keep the persistent 64-band probe active.')
  }
  await refreshProbeState()
}

async function captureTransferProbe() {
  if (probeLabPending.value || measurementBusy.value || !deviceOnline.value) return
  probeLabPending.value = true
  probeLabMessage.value = 'Preparing a 64-band transfer probe…'
  const band = boundedProbeBand()
  const gainDb = boundedProbeGain()
  try {
    if (!await ensurePersistent64()) throw new Error('The TV did not create a verified 64-band diagnostic instance.')
    await applyProbeCurvePayload(probeCurve('common', band, gainDb))
    probeLabMessage.value = `Capture the transfer response for band ${band} at the center position.`
    const aggregate = await captureProbeSweep('transfer')
    probeEvidence.value = [
      ...probeEvidence.value,
      snapshotProbeEvidence('transfer', 'common', band, gainDb, aggregate),
    ]
    probeLabMessage.value = `Transfer response captured for band ${band}. Repeat with other bands, then export the evidence.`
  } catch (error: unknown) {
    probeLabMessage.value = error instanceof Error ? error.message : 'Transfer probe failed.'
  } finally {
    probeLabPending.value = false
  }
}

async function runRoutingProbe() {
  if (probeLabPending.value || measurementBusy.value || !deviceOnline.value) return
  probeLabPending.value = true
  const gainDb = Math.min(0, boundedProbeGain())
  probeLabMessage.value = 'Preparing the one-microphone left/right routing set…'
  try {
    if (!await ensurePersistent64()) throw new Error('The TV did not create a verified 64-band diagnostic instance.')

    const addCapture = (capture: ProbeCaptureEvidence) => {
      probeEvidence.value = [...probeEvidence.value, capture]
    }
    await applyProbeCurvePayload({ bandsDb: Array.from({ length: 64 }, () => 0) })
    probeLabMessage.value = 'Flat baseline: move the one microphone between the fixed left and right positions when prompted.'
    const flat = await captureProbeSweep('routing')
    addCapture(snapshotProbeEvidence('routing', 'flat', ROUTING_TEST_BANDS[0], 0, flat))

    for (const [index, band] of ROUTING_TEST_BANDS.entries()) {
      await applyProbeCurvePayload(probeCurve('left', band, gainDb))
      probeLabMessage.value = `Routing ${index + 1}/${ROUTING_TEST_BANDS.length}: left-only ${gainDb.toFixed(1)} dB cut at band ${band}. Repeat the same left/right microphone positions.`
      const left = await captureProbeSweep('routing')
      addCapture(snapshotProbeEvidence('routing', 'left', band, gainDb, left))

      await applyProbeCurvePayload(probeCurve('right', band, gainDb))
      probeLabMessage.value = `Routing ${index + 1}/${ROUTING_TEST_BANDS.length}: right-only ${gainDb.toFixed(1)} dB cut at band ${band}. Repeat the same left/right microphone positions.`
      const right = await captureProbeSweep('routing')
      addCapture(snapshotProbeEvidence('routing', 'right', band, gainDb, right))
    }
    probeLabMessage.value = 'Four-frequency routing set captured. Compare left-only versus right-only changes at both microphone positions.'
  } catch (error: unknown) {
    probeLabMessage.value = error instanceof Error ? error.message : 'Routing probe failed.'
  } finally {
    try {
      await applyProbeCurvePayload({ bandsDb: Array.from({ length: 64 }, () => 0) })
      await releasePersistent()
    } catch {
      probeLabMessage.value = `${probeLabMessage.value} The probe could not be returned to flat/released; release it from Diagnostics.`
    }
    probeLabPending.value = false
  }
}

function exportProbeEvidence() {
  if (probeEvidence.value.length === 0) return
  const blob = new Blob([JSON.stringify({ version: 1, captures: probeEvidence.value }, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `sweetspot-probe-${new Date().toISOString().replaceAll(':', '-')}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

async function fetchDeviceInfo() {
  if (devInfoPending.value) return
  devInfoPending.value = true
  try {
    const res = await withTimeout(request<DeviceInfoPayload>('diagnostics.deviceInfo'), 20_000)
    if (res) deviceInfo.value = res.payload as DeviceInfoPayload
  } finally {
    devInfoPending.value = false
  }
}

watchEffect(() => {
  if (codeValid.value && status.value === 'disconnected') connect()
})
</script>
