<template>
  <div class="page connect-page">
    <div>
      <ConnectHeaderStatus :status="status" :toast-message="toastMessage" />

      <section v-if="codeError" class="block">
        <p class="error">INVALID PAIR CODE. Scan the QR code on your TV again.</p>
      </section>
      <section v-else-if="pairingError" class="block">
        <p class="error">Scan the QR code shown on the TV to authenticate this connection.</p>
      </section>
      <p v-if="connectionError" class="error transport-error" role="alert">{{ connectionError }}</p>

      <template v-if="!codeError && !pairingError">
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

        <ConnectCalibrationRemoteSection
          v-if="snapshot"
          :snapshot="snapshot"
          :device-online="deviceOnline"
          :job="remoteCalibrationJob"
          :capture-state="remoteCaptureState"
          :capture-error="remoteCaptureError"
          :capture-metadata="remoteCaptureMetadata"
          :profiles="remoteCalibrationProfiles"
          :selected-profile-id="remoteSelectedProfileId"
          :profile-error="remoteProfileError"
          @start="startRemoteCalibration"
          @resume="resumeRemoteCalibration"
          @cancel-capture="cancelRemoteCapture"
          @cancel-refinement="cancelRemoteRefinement"
          @finish="finishRemoteCalibration"
          @discard="discardRemoteCalibration"
          @retry-upload="retryRemoteUpload"
          @select-profile="selectRemoteProfile"
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
          @run-marker-probe="runMarkerProbe"
          @run-production-spacing-marker-probe="runProductionSpacingMarkerProbe"
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

        <ConnectDebugPanel
          v-if="debugLog.length"
          :entries="debugLog"
          :browser-diagnostics="diagnostics"
          :tv-diagnostics="tvTransportDiagnostics"
          @refresh-transport-diagnostics="refreshTransportDiagnostics"
        />
        <ConnectFooter :version="snapshot?.device.appVersion ?? '—'" />
      </template>
    </div>

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
  TransportDiagnosticsPayload,
} from '#shared/types/protocol'
import type { PairingCredentials } from '#shared/transport/signaling'
import { isStateSnapshot } from '#shared/types/protocol'
import { shouldNotifyOffline, transportErrorMessage } from '~/composables/connectionState'
import { onMounted, onScopeDispose, ref, watch, computed, watchEffect } from 'vue'
import '~/components/connect/connect.css'
import ConnectCalibrationRemoteSection from '~/components/connect/ConnectCalibrationRemoteSection.vue'
import ConnectDebugPanel from '~/components/connect/ConnectDebugPanel.vue'
import ConnectDeviceSection from '~/components/connect/ConnectDeviceSection.vue'
import ConnectDiagnosticsSection from '~/components/connect/ConnectDiagnosticsSection.vue'
import ConnectEffectChainSection from '~/components/connect/ConnectEffectChainSection.vue'
import ConnectEqualizerSection from '~/components/connect/ConnectEqualizerSection.vue'
import ConnectFooter from '~/components/connect/ConnectFooter.vue'
import ConnectHeaderStatus from '~/components/connect/ConnectHeaderStatus.vue'
import { useCalibrationRemoteMic } from '~/composables/useCalibrationRemoteMic'
import ConnectStateSection from '~/components/connect/ConnectStateSection.vue'
import { isCalibrationActiveStage } from '~/composables/useCalibrationSession'
import type { AggregateResponse } from '~/lib/audio/measurement/aggregation'
import { allCaptureQualityPassed } from '~/lib/audio/measurement/aggregation'
import { EqCommandRevisionGate } from '~/lib/eq-command-revision'
import { SweetSpotRequestError } from '~/lib/transport/errors'
import type {
  ProbeCaptureEvidence,
} from '~/components/connect/types'

const route = useRoute()

const rawCode = computed(() => String(route.params.code ?? ''))
const codeValid = computed(() => /^[A-Za-z0-9]{6,10}$/.test(rawCode.value.replace(/-/g, '')))
const codeError = computed(() => !codeValid.value)
const room = computed(() => rawCode.value.toUpperCase())
const rendezvousId = computed(() => String(route.query.r ?? '').trim().toLowerCase())
const pairSecret = computed(() => String(route.hash ?? '').replace(/^#/, '').trim())
const pairingError = computed(() => codeValid.value
  && (!/^[a-f0-9]{32}$/.test(rendezvousId.value) || pairSecret.value.length < 32))
const pairing = computed<PairingCredentials | null>(() => {
  if (!codeValid.value || pairingError.value) return null
  return {
    displayCode: room.value,
    rendezvousId: rendezvousId.value,
    pairSecret: pairSecret.value,
  }
})
const debugCaptureExportEnabled = computed(() => route.query.debug === '1')

const connection = useSweetSpotConnection('client', () => pairing.value)
const { status, deviceOnline, debugLog, diagnostics, connect, send, request, onMessage } = connection
const connectionError = computed(() => transportErrorMessage(diagnostics.value?.lastError ?? null))
const snapshot = ref<StateSnapshot | null>(null)
const remoteCalibration = useCalibrationRemoteMic(connection)
const {
  job: remoteCalibrationJob,
  captureState: remoteCaptureState,
  captureError: remoteCaptureError,
  captureMetadata: remoteCaptureMetadata,
  profiles: remoteCalibrationProfiles,
  selectedProfileId: remoteSelectedProfileId,
  profileError: remoteProfileError,
  loadProfiles: loadRemoteCalibrationProfiles,
  refreshJob: refreshRemoteCalibrationJob,
  selectProfile: selectRemoteProfile,
  startNewJob: startRemoteCalibration,
  resumeJob: resumeRemoteCalibration,
  cancelCapture: cancelRemoteCapture,
  cancelOptionalRefinement: cancelRemoteRefinement,
  finishWithBest: finishRemoteCalibration,
  discardJob: discardRemoteCalibration,
  retryUpload: retryRemoteUpload,
} = remoteCalibration
const {
  stage: measurementStage,
  message: measurementMessage,
  aggregateBoth: measurementAggregateBoth,
  probeSummary: measurementProbeSummary,
  startProbe: startProbeSession,
} = useCalibrationSession({
  send: connection.send,
  onMessage: connection.onMessage,
  isDeviceOnline: () => deviceOnline.value,
}, {
  getDeviceIdentity: () => snapshot.value ? {
    id: snapshot.value.device.id,
    appVersion: snapshot.value.device.appVersion,
    buildId: snapshot.value.device.buildId ?? 'unknown',
  } : null,
  debugCaptureExport: debugCaptureExportEnabled.value,
})
const measurementBusy = computed(() => isCalibrationActiveStage(measurementStage.value))
let stateSnapshotRevision = 0
watch(deviceOnline, (online) => {
  if (!online) stateSnapshotRevision = 0
})
const toastMessage = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
let eqRevisionTimer: ReturnType<typeof setTimeout> | null = null
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
const tvTransportDiagnostics = ref<TransportDiagnosticsPayload | null>(null)

const profileName = ref('')

onMounted(() => {
  void loadRemoteCalibrationProfiles().catch(() => undefined)
  refreshRemoteCalibrationJob()
})

watch(deviceOnline, (online) => {
  if (online) refreshRemoteCalibrationJob()
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
})

onMessage((env) => {
  if (env.type !== 'state.snapshot' && env.type !== 'state.changed') return
  if (!eqCommandRevision.shouldApply(env.replyTo)) return
  if (typeof env.payload === 'object' && env.payload !== null && 'ok' in env.payload && env.payload.ok === false) {
    const error = 'error' in env.payload && typeof env.payload.error === 'string' ? env.payload.error : 'live DSP rejected the change'
    showToast(`TV rejected the change: ${error}`)
  }
  if (!isStateSnapshot(env.payload)) {
    showToast('The TV sent an invalid state snapshot. Calibration controls are paused.')
    return
  }
  const next: StateSnapshot = env.payload
  if (next.stateRevision <= stateSnapshotRevision) return
  stateSnapshotRevision = next.stateRevision
  if (env.replyTo !== undefined) {
    eqCommandRevision.settle(env.replyTo)
    if (eqRevisionTimer !== null) clearTimeout(eqRevisionTimer)
    eqRevisionTimer = null
  }
  if (JSON.stringify(next) !== JSON.stringify(snapshot.value)) snapshot.value = next
})

const eqDraft = ref<number[]>([])

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

async function withTimeout<T>(p: Promise<T>, ms: number, reconcile = true): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const result = await Promise.race([
    p.then((value) => ({ kind: 'value' as const, value })).catch((error: unknown) => ({ kind: 'error' as const, error })),
    new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), ms)
    }),
  ])
  if (timer !== null) clearTimeout(timer)
  const timedOut = result.kind === 'timeout'
    || result.kind === 'error' && result.error instanceof SweetSpotRequestError
      && (result.error.kind === 'timeout' || result.error.kind === 'connection')
  if (timedOut && reconcile && deviceOnline.value) {
    const stateReply = await withTimeout(request('state.get', {}, { timeoutMs: 2_000 }), 2_500, false)
    if (stateReply && isStateSnapshot(stateReply.payload)) snapshot.value = stateReply.payload
  }
  return result.kind === 'value' ? result.value : null
}

function responseWasAccepted(payload: unknown): boolean {
  return typeof payload === 'object'
    && payload !== null
    && 'ok' in payload
    && payload.ok === true
}

function getState() {
  request('state.get')
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
    qualityPassed: allCaptureQualityPassed(aggregate),
    capturedAt: new Date().toISOString(),
    positionResponses: JSON.parse(JSON.stringify(aggregate.positionResponses)) as AggregateResponse['positionResponses'],
    spatialConsistency: JSON.parse(JSON.stringify(aggregate.spatialConsistency)) as AggregateResponse['spatialConsistency'],
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

type MarkerProbeKind = 'marker-only' | 'marker-production-spacing'

async function runMarkerProbe(kind: MarkerProbeKind = 'marker-only') {
  if (probeLabPending.value || measurementBusy.value || !deviceOnline.value) return
  probeLabPending.value = true
  const label = kind === 'marker-only' ? 'marker-only' : 'production-spacing marker'
  probeLabMessage.value = `Running the ${label} set at the five fixed positions…`
  try {
    await new Promise<void>((resolve, reject) => {
      let started = false
      const stop = watch(measurementStage, (nextStage) => {
        if (!started) return
        if (nextStage === 'complete') {
          stop()
          resolve()
        } else if (nextStage === 'error' || nextStage === 'idle') {
          stop()
          reject(new Error(measurementMessage.value || 'The marker probe was cancelled.'))
        }
      }, { immediate: true })
      startProbeSession(kind)
      started = true
    })
    const summary = measurementProbeSummary.value
    const displayLabel = `${label[0]?.toUpperCase() ?? ''}${label.slice(1)}`
    probeLabMessage.value = summary.passed
      ? `${displayLabel} set passed at ${summary.completedPositionCount} physical positions after ${summary.historicalAttemptCount} attempts.`
      : `${displayLabel} set finished with ${summary.failedPositionIds.length} failed physical position${summary.failedPositionIds.length === 1 ? '' : 's'}. Export the debug bundle for candidate and pair diagnostics.`
  } catch (error: unknown) {
    probeLabMessage.value = error instanceof Error ? error.message : `${label[0]?.toUpperCase() ?? ''}${label.slice(1)} probe failed.`
  } finally {
    probeLabPending.value = false
  }
}

function runProductionSpacingMarkerProbe() {
  return runMarkerProbe('marker-production-spacing')
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

async function refreshTransportDiagnostics() {
  if (!deviceOnline.value) return
  const res = await withTimeout(request<TransportDiagnosticsPayload>('diagnostics.transport'), 10_000)
  if (res) tvTransportDiagnostics.value = res.payload
}

watchEffect(() => {
  if (pairing.value && status.value === 'disconnected') connect()
})
</script>
