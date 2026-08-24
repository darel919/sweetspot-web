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
          :measurement-profiles="measurementProfiles"
          :measurement-selected-profile-id="measurementSelectedProfileId"
          :measurement-profile-error="measurementProfileError"
          :recommended-correction="recommendedCorrection"
          :correction-strength="correctionStrength"
          :correction-strength-options="correctionStrengthOptions"
          :correction-pending="correctionPending"
          :calibration-applied="calibrationApplied"
          :rollback-available="rollbackState !== null"
          :validation-worse="validationWorse"
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
        />

        <ConnectDiagnosticsSection
          v-if="snapshot"
          :diag-pending="diagPending"
          :probe="probe"
          :probe-pending="probePending"
          :persistent-state="persistentState"
          :persist-bands="persistBands"
          :virtualizer-on="virtualizerOn"
          :device-info="deviceInfo"
          :dev-info-pending="devInfoPending"
          @run-effects-diagnostics="runEffectsDiagnostics"
          @run-capacity-probe="runCapacityProbe"
          @set-persist-bands="persistBands = $event"
          @create-persistent="createPersistent"
          @release-persistent="releasePersistent"
          @apply-test-curve="applyTestCurve"
          @quick-audible="quickAudible"
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
  OkReply,
  PersistentProbeState,
  PresetOption,
  ProbeDiagnostics,
  StateSnapshot,
} from '#shared/types/protocol'
import { calculateCorrection, combineChannelAggregates, targetErrorRms, type CorrectionStrength } from '~/lib/audio/correction/optimizer'
import { mapCorrectionToBands } from '~/lib/audio/correction/bandMapper'
import { shouldNotifyOffline } from '~/composables/connectionState'
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
  validationAggregateLeft: measurementValidationAggregateLeft,
  validationAggregateRight: measurementValidationAggregateRight,
  repeatabilityPassed: measurementRepeatabilityPassed,
  failedRepeatabilityGroups: measurementFailedGroups,
  currentPosition: measurementCurrentPosition,
  currentChannel: measurementCurrentChannel,
  progress: measurementProgress,
  estimatedRemainingSeconds: measurementEstimatedRemainingSeconds,
  captureInfo: measurementCaptureInfo,
  profiles: measurementProfiles,
  selectedProfileId: measurementSelectedProfileId,
  profileError: measurementProfileError,
  loadProfiles: loadMeasurementProfiles,
  start: startMeasurementSession,
  startValidation: startValidationSession,
  retryFailedGroups,
  confirmLoudness,
  continuePosition: continueMeasurement,
  cancel: cancelMeasurement,
} = useCalibrationSession(connection)
const measurementBusy = computed(() => isCalibrationActiveStage(measurementStage.value))
const calibrationLocked = measurementBusy
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
const persistBands = ref<number | string>(64)

const deviceInfo = ref<DeviceInfoPayload | null>(null)
const devInfoPending = ref(false)

const calJson = ref('')
const calStatus = ref('')
const calIsError = ref(false)
const profileName = ref('')
const correctionPending = ref(false)
const calibrationApplied = ref(false)
const rollbackState = ref<{
  active: boolean
  bandsDb: number[]
  leftBandsDb?: number[]
  rightBandsDb?: number[]
} | null>(null)
const correctionStrength = ref<CorrectionStrength>('normal')
const correctionStrengthOptions: readonly CorrectionStrengthOption[] = [
  { id: 'gentle', label: 'Gentle' },
  { id: 'normal', label: 'Normal' },
  { id: 'strong', label: 'Strong' },
]

type CalibrationApplyReply = OkReply & {
  calibration?: { applicationError?: string | null }
}

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
  const commonBands = mapCorrectionToBands(common.correction, bandCutoffs)
  const commonSummary = mappedCorrectionSummary(commonBands)
  if (!independent || !measurementAggregateLeft.value || !measurementAggregateRight.value) {
    return {
      bandsDb: commonBands,
      independent: false,
      ...commonSummary,
    }
  }
  const left = calculateCorrection(measurementAggregateLeft.value, profile, { strength: correctionStrength.value, headroomVerified })
  const right = calculateCorrection(measurementAggregateRight.value, profile, { strength: correctionStrength.value, headroomVerified })
  const leftBandsDb = mapCorrectionToBands(left.correction, bandCutoffs)
  const rightBandsDb = mapCorrectionToBands(right.correction, bandCutoffs)
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

const validationMetrics = computed<CalibrationValidationMetrics | null>(() => {
  const before = measurementAggregateBoth.value?.positionResponses.find((response) => response.positionId === 'center')
  const after = validationAggregate.value?.positionResponses.find((response) => response.positionId === 'center')
  if (!before || !after) return null
  return { before: targetErrorRms(before.points), after: targetErrorRms(after.points) }
})

const validationWorse = computed(() => {
  const metrics = validationMetrics.value
  return metrics !== null && metrics.after > metrics.before + 0.5
})

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
  syncCalibrationLock(false)
})

onMessage((env) => {
  if (env.type !== 'state.snapshot') return
  if (!eqCommandRevision.shouldApply(env.replyTo)) return
  if (env.replyTo !== undefined) {
    eqCommandRevision.settle(env.replyTo)
    if (eqRevisionTimer !== null) clearTimeout(eqRevisionTimer)
    eqRevisionTimer = null
  }
  const next = env.payload as StateSnapshot
  if (JSON.stringify(next) === JSON.stringify(snapshot.value)) return
  snapshot.value = next
})

const eqDraft = ref<number[]>([])

watch(snapshot, (s) => {
  if (!s) return
  if (eqDraftRevision === eqSentRevision) eqDraft.value = [...s.userEq.bandsDb]
  if (!calJson.value.trim()) {
    calJson.value = JSON.stringify(s.calibration.bandsDb.map((v) => Math.round(v * 10) / 10))
  }
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
    return arr.map((v) => Number(v))
  } catch {
    return null
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))])
}

function captureRollbackState() {
  const calibration = snapshot.value?.calibration
  const bandsDb = calibration?.requestedBandsDb ?? calibration?.bandsDb
  if (!calibration || !bandsDb || bandsDb.length !== 64) return null
  return {
    active: calibration.active,
    bandsDb: [...bandsDb],
    ...(calibration.independent && (calibration.requestedLeftBandsDb ?? calibration.leftBandsDb)?.length === 64 && (calibration.requestedRightBandsDb ?? calibration.rightBandsDb)?.length === 64
      ? {
          leftBandsDb: [...(calibration.requestedLeftBandsDb ?? calibration.leftBandsDb ?? [])],
          rightBandsDb: [...(calibration.requestedRightBandsDb ?? calibration.rightBandsDb ?? [])],
        }
      : {}),
  }
}

function rememberRollbackState() {
  const previous = captureRollbackState()
  if (previous) rollbackState.value = previous
}

async function applyCalibration() {
  const bandsDb = parseCurve(calJson.value)
  calIsError.value = bandsDb == null
  if (bandsDb == null) {
    calStatus.value = 'Need a JSON array of exactly 64 numbers.'
    return
  }
  rememberRollbackState()
  calStatus.value = 'Applying…'
  const res = await withTimeout(request<OkReply>('calibration.apply', { bandsDb }), 15_000)
  if (!res) {
    calIsError.value = true
    calStatus.value = 'TV did not answer within 15s.'
    return
  }
  const payload = res.payload as CalibrationApplyReply
  calIsError.value = payload.ok === false
  calStatus.value = payload.ok === false
    ? 'Device rejected curve: ' + (payload.error ?? payload.calibration?.applicationError ?? 'unknown')
    : 'Curve applied.'
  void request('state.get')
}

async function applyRecommendedCorrection() {
  const correction = recommendedCorrection.value
  if (measurementStage.value !== 'complete' || !correction || !measurementRepeatabilityPassed.value || correctionPending.value) return
  if (!deviceOnline.value) {
    showToast('The TV connection is offline. The correction cannot apply.')
    return
  }
  correctionPending.value = true
  const previous = captureRollbackState()
  calStatus.value = 'Applying recommended correction…'
  try {
    const payload: Record<string, unknown> = { bandsDb: correction.bandsDb }
    if (correction.independent && correction.leftBandsDb && correction.rightBandsDb) {
      payload.leftBandsDb = correction.leftBandsDb
      payload.rightBandsDb = correction.rightBandsDb
    }
    const res = await withTimeout(request<OkReply>('calibration.apply', payload), 15_000)
    if (!res) {
      calIsError.value = true
      calStatus.value = 'TV did not answer within 15s.'
      return
    }
    const result = res.payload as CalibrationApplyReply
    calIsError.value = result.ok === false
    calStatus.value = result.ok === false
      ? 'Device rejected correction: ' + (result.error ?? result.calibration?.applicationError ?? 'unknown')
      : correction.independent
        ? 'Independent left/right correction applied.'
        : 'Common correction applied.'
    calibrationApplied.value = result.ok !== false
    if (result.ok !== false && previous) rollbackState.value = previous
    calJson.value = JSON.stringify(correction.bandsDb.map((value) => Math.round(value * 10) / 10))
    void request('state.get')
  } finally {
    correctionPending.value = false
  }
}

async function rollbackCalibration() {
  const previous = rollbackState.value
  if (!previous || correctionPending.value) return
  correctionPending.value = true
  calStatus.value = 'Rolling back the last calibration…'
  try {
    const res = previous.active
      ? await withTimeout(request<OkReply>('calibration.apply', {
          bandsDb: previous.bandsDb,
          ...(previous.leftBandsDb && previous.rightBandsDb
            ? { leftBandsDb: previous.leftBandsDb, rightBandsDb: previous.rightBandsDb }
            : {}),
        }), 15_000)
      : await withTimeout(request('calibration.reset'), 15_000)
    if (!res) {
      calIsError.value = true
      calStatus.value = 'TV did not answer within 15s.'
      return
    }
    const result = res.payload as CalibrationApplyReply
    if (result.ok === false) {
      calIsError.value = true
      calStatus.value = 'TV rejected the rollback: ' + (result.error ?? result.calibration?.applicationError ?? 'unknown')
      return
    }
    rollbackState.value = null
    calibrationApplied.value = previous.active
    calJson.value = JSON.stringify(previous.bandsDb.map((value) => Math.round(value * 10) / 10))
    calIsError.value = false
    calStatus.value = 'Previous calibration restored.'
    void request('state.get')
  } finally {
    correctionPending.value = false
  }
}

async function resetCalibration() {
  calStatus.value = 'Resetting…'
  await withTimeout(request('calibration.reset'), 15_000)
  rollbackState.value = null
  calibrationApplied.value = false
  calStatus.value = 'Calibration reset.'
  void request('state.get')
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
  rollbackState.value = null
  void startMeasurementSession()
}

function startValidation() {
  if (!deviceOnline.value) {
    showToast('The TV connection is offline. Validation cannot start.')
    return
  }
  void startValidationSession()
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
  const input = persistBands.value
  const numericBands = typeof input === 'number' ? input : input === '' ? 64 : parseFloat(input)
  const bands = Math.max(1, Math.min(64, Math.round(numericBands || 64)))
  persistBands.value = bands
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

async function quickAudible(bands: number) {
  await withTimeout(request('probe.persistent.start', { bands }), 30_000)
  await withTimeout(request('probe.curve.apply', { curve: 'hollow' }), 20_000)
  await refreshProbeState()
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
