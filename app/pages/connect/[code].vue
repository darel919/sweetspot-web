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
          @confirm-loudness="confirmLoudness"
          @continue-measurement="continueMeasurement"
          @cancel-measurement="cancelMeasurement"
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
      :stage="measurementStage"
      :message="measurementMessage"
      :current-position="measurementCurrentPosition"
      :current-channel="measurementCurrentChannel"
      :current-instruction="measurementCurrentInstruction"
      :progress="measurementProgress"
      :estimated-remaining-seconds="measurementEstimatedRemainingSeconds"
      @confirm-loudness="confirmLoudness"
      @continue-measurement="continueMeasurement"
      @cancel-measurement="cancelMeasurement"
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
import type {
  AggregateResponse,
} from '~/lib/audio/measurement/aggregation'
import { allRepeatabilityPassed } from '~/lib/audio/measurement/aggregation'
import { EqCommandRevisionGate } from '~/lib/eq-command-revision'
import type {
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
  currentChannel: measurementCurrentChannel,
  currentInstruction: measurementCurrentInstruction,
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
  confirmLoudness,
  continuePosition: continueMeasurement,
  cancel: cancelMeasurement,
} = useCalibrationSession(connection)
const measurementBusy = computed(() => isCalibrationActiveStage(measurementStage.value))
const calibrationLocked = measurementBusy
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

const snapshot = ref<StateSnapshot | null>(null)
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
const correctionPending = ref(false)
const calibrationApplied = ref(false)
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
  const commonBands = mapCorrectionToBandsConservative(common.correction, bandCutoffs)
  const commonSummary = {
    ...mappedCorrectionSummary(commonBands),
    lfExtension3DbHz: common.lfExtension3DbHz,
    lfExtension6DbHz: common.lfExtension6DbHz,
    lfExtensionConfidence: common.lfExtensionConfidence,
  }
  if (!independent || !measurementAggregateLeft.value || !measurementAggregateRight.value) {
    return {
      bandsDb: commonBands,
      independent: false,
      ...commonSummary,
    }
  }
  const left = calculateCorrection(measurementAggregateLeft.value, profile, { strength: correctionStrength.value, headroomVerified })
  const right = calculateCorrection(measurementAggregateRight.value, profile, { strength: correctionStrength.value, headroomVerified })
  const leftBandsDb = mapCorrectionToBandsConservative(left.correction, bandCutoffs)
  const rightBandsDb = mapCorrectionToBandsConservative(right.correction, bandCutoffs)
  const channelSummary = mappedCorrectionSummary([...leftBandsDb, ...rightBandsDb])
  return {
    bandsDb: commonBands,
    leftBandsDb,
    rightBandsDb,
    independent: true,
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

const candidateTransaction = computed<Extract<CalibrationTransaction, { state: 'candidate_pending' }> | null>(() => {
  const transaction = snapshot.value?.calibration.transaction
  return transaction?.state === 'candidate_pending' ? transaction : null
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

const validationReady = computed(() => validationBaselineReady.value && deviceValidationReady.value)

const validationOutcome = computed(() => {
  if (measurementStage.value !== 'complete' || !candidateTransaction.value) return null
  if (candidateTransaction.value.validationStatus !== 'pending') return null
  if (!measurementValidationAggregateLeft.value
    || !measurementValidationAggregateRight.value
    || !allRepeatabilityPassed(measurementValidationAggregateLeft.value)
    || !allRepeatabilityPassed(measurementValidationAggregateRight.value)) {
    return { status: 'inconclusive' as const, reason: 'Validation measurements were not repeatable.' }
  }
  const metrics = validationMetrics.value
  if (!metrics || !Number.isFinite(metrics.before) || !Number.isFinite(metrics.after)) {
    return { status: 'inconclusive' as const, reason: 'Validation metrics were unavailable.' }
  }
  return metrics.after > metrics.before + CALIBRATION_VALIDATION_WORSE_TOLERANCE_DB
    ? { status: 'worse' as const, beforeDb: metrics.before, afterDb: metrics.after }
    : { status: 'passed' as const, beforeDb: metrics.before, afterDb: metrics.after }
})

const validationOutcomeKey = computed(() => {
  const outcome = validationOutcome.value
  if (!outcome || !candidateTransaction.value) return null
  return JSON.stringify({ candidateId: candidateTransaction.value.candidateId, ...outcome })
})
let lastSentValidationOutcomeKey: string | null = null
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
  if (JSON.stringify(next) === JSON.stringify(snapshot.value)) return
  snapshot.value = next
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

watch([measurementStage, validationOutcomeKey, deviceOnline], ([stage, outcomeKey]) => {
  if (stage !== 'complete' || !outcomeKey || outcomeKey === lastSentValidationOutcomeKey || validationResultInFlight) return
  const transaction = candidateTransaction.value
  const outcome = validationOutcome.value
  if (!transaction || !outcome) return
  validationResultInFlight = true
  const payload = outcome.status === 'passed' || outcome.status === 'worse'
    ? {
        candidateId: transaction.candidateId,
        status: outcome.status,
        beforeDb: outcome.beforeDb,
        afterDb: outcome.afterDb,
      }
    : {
        candidateId: transaction.candidateId,
        status: outcome.status,
        reason: outcome.reason,
      }
  void withTimeout(request('calibration.validation.result', payload), 15_000)
    .then((result) => {
      if (result && responseWasAccepted(result.payload)) lastSentValidationOutcomeKey = outcomeKey
      else if (result) showToast('The TV rejected the validation result. It remains pending.')
    })
    .finally(() => {
      validationResultInFlight = false
    })
})

watch([measurementStage, measurementValidationActive, candidateTransaction, deviceOnline], ([stage, validationActive, transaction]) => {
  if (stage !== 'error' || !validationActive || !transaction || validationResultInFlight) return
  const outcomeKey = `${transaction.candidateId}:failed:${measurementMessage.value}`
  if (outcomeKey === lastSentValidationOutcomeKey) return
  validationResultInFlight = true
  void withTimeout(request('calibration.validation.result', {
    candidateId: transaction.candidateId,
    status: 'failed',
    reason: measurementMessage.value || 'Validation measurement failed.',
  }), 15_000)
    .then((result) => {
      if (result && responseWasAccepted(result.payload)) lastSentValidationOutcomeKey = outcomeKey
      else if (result) showToast('The TV rejected the validation result. It remains pending.')
    })
    .finally(() => {
      validationResultInFlight = false
    })
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
  if (candidateStaged && action.snapshot) calibrationApplied.value = action.snapshot.calibration.active
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
    const payload: Record<string, unknown> = { bandsDb: correction.bandsDb }
    if (correction.independent && correction.leftBandsDb && correction.rightBandsDb) {
      payload.leftBandsDb = correction.leftBandsDb
      payload.rightBandsDb = correction.rightBandsDb
    }
    const res = await withTimeout(request('calibration.applyCandidate', payload), 15_000)
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
    if (candidateStaged && action.snapshot) {
      calibrationApplied.value = action.snapshot.calibration.active
      calJson.value = JSON.stringify((action.snapshot.calibration.requestedBandsDb ?? action.snapshot.calibration.bandsDb).map((value) => Math.round(value * 10) / 10))
    }
  } finally {
    correctionPending.value = false
  }
}

async function rollbackCalibration() {
  const transaction = candidateTransaction.value
  if (!transaction || correctionPending.value) return
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
  if (!transaction || correctionPending.value) return
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
  if (!deviceOnline.value) {
    showToast('The TV connection is offline. Calibration cannot start.')
    return
  }
  calibrationApplied.value = false
  void startMeasurementSession()
}

function startValidation() {
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
