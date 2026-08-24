<template>
  <div class="page">
    <header class="masthead">
      <div class="brand">
        <h1>SWEETSPOT</h1>
        <p class="sub">remote equalizer console</p>
      </div>
      <div class="conn" :data-state="status">
        <span class="conn-dot"></span>
        <span class="conn-label">{{ status }}</span>
      </div>
    </header>

    <Transition name="toast">
      <div v-if="toastMessage" class="toast" role="status" aria-live="assertive">
        {{ toastMessage }}
      </div>
    </Transition>

    <section v-if="codeError" class="block">
      <p class="error">INVALID PAIR CODE. Scan the QR code on your TV again.</p>
    </section>

    <template v-else>
      <section class="block">
        <h2 class="label">01 · Device</h2>
        <dl class="spec">
          <dt>room</dt>
          <dd>{{ room }}</dd>
          <dt>television</dt>
          <dd>{{ deviceOnline ? 'online' : 'offline' }}</dd>
          <dt>engine</dt>
          <dd>
            <template v-if="snapshot">
              {{ snapshot.engine.enabled ? (snapshot.engine.hasControl ? 'active' : 'no control') : 'bypassed' }}
              <span class="dim">/</span> {{ snapshot.engine.presetName }}
            </template>
            <template v-else>unknown</template>
          </dd>
        </dl>
      </section>

      <section v-if="snapshot" class="block">
        <h2 class="label">02 · Equalizer</h2>

        <div class="actions">
          <button @click="setEngine(true)" :disabled="snapshot.engine.enabled">Enable</button>
          <button :disabled="!snapshot.engine.enabled" @click="setEngine(false)">Bypass</button>
        </div>

        <div v-if="presets.length" class="actions">
          <span class="mini-label">preset</span>
          <button
            v-for="p in presets"
            :key="p.id"
            :class="{ active: snapshot.engine.activePreset === p.id }"
            @click="applyPreset(p.id)"
          >
            {{ p.name }}
          </button>
        </div>

        <div class="band-scroll">
          <div v-for="(lvl, i) in eqDraft" :key="i" class="band">
            <span class="band-val">{{ lvl.toFixed(1) }}</span>
            <input
              type="range"
              :min="snapshot.userEq.minDb"
              :max="snapshot.userEq.maxDb"
              step="0.5"
              :value="lvl"
              @input="onBandInput(i, $event)"
              @change="commitBands"
            />
            <span class="band-hz">{{ hzLabel(snapshot.userEq.frequenciesHz[i]) }}</span>
          </div>
        </div>

        <div class="actions">
          <button :disabled="!eqDirty" @click="resetBands">Discard changes</button>
        </div>

        <form class="inline-form" @submit.prevent="saveProfile">
          <input v-model="profileName" type="text" placeholder="new profile name" />
          <button type="submit" :disabled="!profileName.trim()">Save</button>
        </form>

        <ul v-if="snapshot.profiles.length" class="list">
          <li v-for="p in snapshot.profiles" :key="p.id">
            <span>{{ p.name }}</span>
            <span class="list-actions">
              <button @click="loadProfile(p.name)">Load</button>
              <button @click="deleteProfile(p.name)">Delete</button>
            </span>
          </li>
        </ul>
        <p v-else class="note">No saved profiles.</p>
      </section>

      <section v-if="snapshot" class="block">
        <h2 class="label">03 · Calibration</h2>
        <h3 class="sub-label">Room measurement</h3>
        <p class="note">
          Follow the instructions shown on the TV. The browser captures the microphone and analyzes the sweep locally. Raw microphone audio never leaves this browser.
        </p>
        <div v-if="measurementProfiles.length" class="actions">
          <label class="inline-form">
            <span class="mini-label">microphone profile</span>
            <select v-model="measurementSelectedProfileId" :disabled="measurementBusy">
              <option v-for="profile in measurementProfiles" :key="profile.id" :value="profile.id">
                {{ profile.name }}
              </option>
            </select>
          </label>
        </div>
        <p v-if="measurementProfileError" class="error">{{ measurementProfileError }}</p>
        <p v-else-if="!measurementProfiles.length" class="note">Loading microphone profiles…</p>
        <p v-if="!snapshot.capabilities.supportsSweep" class="note">
          This TV build does not advertise a target-validated sweep yet. Calibration is unavailable until the real TV output path has been tested.
        </p>
        <div class="actions">
          <button
            :disabled="!snapshot.capabilities.supportsSweep || measurementBusy"
            @click="startMeasurement"
          >
            {{ measurementBusy ? measurementMessage : 'Start measurement' }}
          </button>
          <button v-if="measurementBusy" @click="cancelMeasurement">Cancel</button>
        </div>
        <p v-if="measurementMessage" class="note">{{ measurementMessage }}</p>

        <dl v-if="measurementCaptureInfo" class="spec">
          <dt>sample rate</dt><dd>{{ measurementCaptureInfo.settings.sampleRate ?? 'unknown' }} Hz</dd>
          <dt>channels</dt><dd>{{ measurementCaptureInfo.settings.channelCount ?? 'unknown' }}</dd>
          <dt>echo cancellation</dt><dd>{{ settingLabel(measurementCaptureInfo.settings.echoCancellation) }}</dd>
          <dt>noise suppression</dt><dd>{{ settingLabel(measurementCaptureInfo.settings.noiseSuppression) }}</dd>
          <dt>auto gain</dt><dd>{{ settingLabel(measurementCaptureInfo.settings.autoGainControl) }}</dd>
        </dl>

        <div v-if="measurementAnalysis" class="response-graph">
          <p class="mini-label">Measured response, mic-compensated relative display</p>
          <svg viewBox="0 0 800 280" role="img" aria-label="Measured speaker response">
            <line x1="0" y1="140" x2="800" y2="140" class="graph-zero" />
            <polyline :points="responsePolyline(measurementAnalysis.points)" class="graph-line" />
            <text x="0" y="268" class="graph-label">20 Hz</text>
            <text x="760" y="268" class="graph-label">20 kHz</text>
            <text x="8" y="16" class="graph-label">+12 dB</text>
            <text x="8" y="154" class="graph-label">0 dB</text>
            <text x="8" y="276" class="graph-label">−12 dB</text>
          </svg>
          <dl class="spec">
            <dt>signal RMS</dt><dd>{{ dbfs(measurementAnalysis.diagnostics.signalRms) }}</dd>
            <dt>peak</dt><dd>{{ dbfs(measurementAnalysis.diagnostics.signalPeak) }}</dd>
            <dt>detected offset</dt><dd>{{ measurementAnalysis.diagnostics.detectionOffsetMs?.toFixed(1) ?? 'unknown' }} ms</dd>
            <dt>clipping</dt><dd>{{ measurementAnalysis.diagnostics.clipped ? 'yes' : 'no' }}</dd>
            <dt>mic profile</dt><dd>{{ measurementAnalysis.micProfile.name }}</dd>
            <dt>profile source</dt>
            <dd>
              <a :href="measurementAnalysis.micProfile.sourceUrl" target="_blank" rel="noreferrer">
                {{ measurementAnalysis.micProfile.dataMethod }}, {{ measurementAnalysis.micProfile.sourceDate }}
              </a>
            </dd>
            <dt>capture path</dt><dd>{{ measurementAnalysis.micProfile.capturePath }}</dd>
          </dl>
        </div>

        <dl class="spec">
          <dt>status</dt>
          <dd>{{ snapshot.calibration.active ? 'active' : 'inactive' }}</dd>
          <dt>bands</dt>
          <dd>{{ snapshot.calibration.bandsDb.length }}</dd>
        </dl>
        <details class="fold">
          <summary>Curve JSON</summary>
          <textarea v-model="calJson" rows="4" spellcheck="false"></textarea>
          <div class="actions">
            <button @click="applyCalibration">Apply curve</button>
            <button @click="resetCalibration">Reset to flat</button>
          </div>
          <p v-if="calStatus" class="note">{{ calStatus }}</p>
        </details>
      </section>

      <section v-if="snapshot" class="block">
        <h2 class="label">04 · Diagnostics</h2>
        <p class="note">Upmix experiments. Effect-chain inventory, DynamicsProcessing capacity, persistent test instances.</p>

        <div class="actions">
          <button :disabled="diagPending" @click="runEffectsDiagnostics">
            {{ diagPending ? 'Working…' : 'Effect chain' }}
          </button>
          <button :disabled="probePending" @click="runCapacityProbe">
            {{ probePending ? 'Probing…' : 'Capacity probe' }}
          </button>
        </div>

        <template v-if="probe">
          <dl class="spec">
            <dt>highest reliable</dt><dd>{{ probe.highest }} bands</dd>
            <dt>recommended</dt><dd>{{ probe.recommended }} bands</dd>
          </dl>
          <table v-if="probe.results.length" class="grid">
            <thead>
              <tr><th>bands</th><th>result</th><th>actual</th><th>control</th><th>enabled</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in probe.results" :key="r.requested">
                <td>{{ r.requested }}</td>
                <td>{{ r.pass ? 'PASS' : 'FAIL' }}</td>
                <td>{{ r.actualBands }}</td>
                <td>{{ r.hasControl }}</td>
                <td>{{ r.enabled }}</td>
              </tr>
            </tbody>
          </table>
        </template>

        <h3 class="sub-label">Persistent instance</h3>
        <form class="inline-form" @submit.prevent="createPersistent">
          <input v-model.number="persistBands" type="number" min="1" max="64" />
          <button type="submit">Create enabled</button>
          <button type="button" @click="releasePersistent">Release</button>
        </form>
        <p v-if="persistentState" class="note">
          {{ persistentState.active ? `ACTIVE at ${persistentState.bands} bands` : 'none' }}
          <template v-if="persistentState.active && persistentState.curve"> · curve {{ persistentState.curve }}</template>
          <template v-if="persistentState.curveSummary">
            · {{ persistentState.curveSummary.bandsCut }} cut / {{ persistentState.curveSummary.bandsFlat }} flat
          </template>
        </p>

        <h3 class="sub-label">Audible test curves</h3>
        <p class="note">Dramatic EQ through the persistent instance. Proof it sits on the live path.</p>
        <div class="actions">
          <button @click="applyTestCurve('hollow')">Hollow mids</button>
          <button @click="applyTestCurve('flat')">Flat</button>
          <button v-for="n in [16, 32, 64]" :key="n" @click="quickAudible(n)">Hollow @ {{ n }}</button>
        </div>

        <h3 class="sub-label">Virtualizer A/B</h3>
        <p class="note">Persistent session-0 Virtualizer at max strength. Toggle while playing stereo through AUX.</p>
        <div class="actions">
          <button :class="{ active: virtualizerOn }" @click="setVirtualizer(true)">Virtualizer ON</button>
          <button :class="{ active: !virtualizerOn }" @click="setVirtualizer(false)">Virtualizer OFF</button>
        </div>
        <p class="note">{{ virtualizerOn ? 'Widening active' : 'Bypassed' }}</p>

        <h3 class="sub-label">Device info</h3>
        <div class="actions">
          <button :disabled="devInfoPending" @click="fetchDeviceInfo">
            {{ devInfoPending ? 'Sampling…' : 'Sample CPU / memory' }}
          </button>
        </div>
        <dl v-if="deviceInfo" class="spec">
          <dt>app cpu</dt><dd>{{ deviceInfo.cpuPercent.toFixed(1) }}%</dd>
          <dt>audioserver cpu</dt>
          <dd>{{ deviceInfo.audioserverPid != null ? deviceInfo.audioserverCpuPercent.toFixed(1) + '%' : 'n/a' }}</dd>
          <dt>native heap</dt><dd>{{ fmtBytes(deviceInfo.nativeHeapAllocated) }} / {{ fmtBytes(deviceInfo.nativeHeapSize) }}</dd>
          <dt>java heap</dt><dd>{{ fmtBytes(deviceInfo.javaHeapTotal - deviceInfo.javaHeapFree) }} / {{ fmtBytes(deviceInfo.javaHeapMax) }}</dd>
          <dt>pss</dt><dd>{{ fmtBytes(deviceInfo.pssTotalKb * 1024) }}</dd>
        </dl>
      </section>

      <section v-if="effectsDiagnostics" class="block">
        <h2 class="label">05 · Effect chain</h2>
        <p v-if="effectsDiagnostics.error" class="error">{{ effectsDiagnostics.error }}</p>
        <template v-else>
          <table v-if="effectsDiagnostics.inventory.length" class="grid">
            <thead>
              <tr><th>type</th><th>name</th><th>mode</th><th>vendor</th></tr>
            </thead>
            <tbody>
              <tr v-for="(e, i) in effectsDiagnostics.inventory" :key="i">
                <td>{{ e.typeName }}<span v-if="e.isVendor" class="mark">*</span></td>
                <td>{{ e.name }}</td>
                <td>{{ e.connectMode }}</td>
                <td>{{ e.isVendor ? 'yes' : '' }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="note">No effects reported.</p>

          <dl class="spec wide">
            <template v-for="p in effectsDiagnostics.sessionProbes" :key="p.effectType">
              <dt>{{ p.effectType }}</dt>
              <dd>
                <template v-if="!p.constructed">failed: {{ p.exception }}</template>
                <template v-else>
                  constructed · control {{ p.hasControl }} · enabled {{ p.enabled }}
                  <code>{{ p.parameters }}</code>
                </template>
              </dd>
            </template>
          </dl>
          <details class="fold">
            <summary>Raw JSON</summary>
            <pre class="log">{{ JSON.stringify(effectsDiagnostics, null, 2) }}</pre>
          </details>
        </template>
      </section>

      <section v-else class="block">
        <h2 class="label">05 · State</h2>
        <p v-if="status === 'offline'" class="note">The TV is offline. Open SweetSpot on the TV.</p>
        <div v-else-if="status === 'connected'" class="actions">
          <button @click="getState">Request state</button>
        </div>
        <p v-else class="note">Connecting…</p>
      </section>

      <details v-if="debugLog.length" class="block fold">
        <summary>Debug log · {{ debugLog.length }}</summary>
        <pre class="log">{{ debugLog.map(l => `${new Date(l.at).toISOString()} ${l.direction.toUpperCase()} ${l.text}`).join('\n') }}</pre>
      </details>

      <footer class="colophon">
        <span>sweetspot-web</span>
        <span>{{ snapshot?.device.appVersion ?? '—' }}</span>
      </footer>
    </template>
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
import type { ResponsePoint } from '~/lib/audio/measurement/response'
import { shouldNotifyOffline } from '~/composables/connectionState'
import { onMounted, onScopeDispose } from 'vue'

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
  captureInfo: measurementCaptureInfo,
  profiles: measurementProfiles,
  selectedProfileId: measurementSelectedProfileId,
  profileError: measurementProfileError,
  loadProfiles: loadMeasurementProfiles,
  start: startMeasurementSession,
  cancel: cancelMeasurement,
} = useCalibrationSession(connection)
const measurementBusy = computed(() => ['requesting-microphone', 'preparing', 'recording', 'analyzing', 'ending'].includes(measurementStage.value))
const toastMessage = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null

const snapshot = ref<StateSnapshot | null>(null)
const effectsDiagnostics = ref<EffectsDiagnostics | null>(null)
const diagPending = ref(false)

const probe = ref<ProbeDiagnostics | null>(null)
const probePending = ref(false)
const persistentState = ref<PersistentProbeState | null>(null)
const persistBands = ref(64)

const deviceInfo = ref<DeviceInfoPayload | null>(null)
const devInfoPending = ref(false)

const calJson = ref('')
const calStatus = ref('')
const calIsError = ref(false)
const profileName = ref('')

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
})

onMessage((env) => {
  if (env.type !== 'state.snapshot') return
  const next = env.payload as StateSnapshot
  if (JSON.stringify(next) === JSON.stringify(snapshot.value)) return
  snapshot.value = next
})

watch(snapshot, (s) => {
  if (!s) return
  eqDraft.value = [...s.userEq.bandsDb]
  if (!calJson.value.trim()) {
    calJson.value = JSON.stringify(s.calibration.bandsDb.map((v) => Math.round(v * 10) / 10))
  }
})

const presets = computed<PresetOption[]>(() => snapshot.value?.capabilities.presets ?? [])

function hzLabel(hz?: number): string {
  if (hz == null) return ''
  return hz >= 1000 ? `${Math.round(hz / 100) / 10}k` : String(hz)
}

const eqDraft = ref<number[]>([])

const eqDirty = computed(() => {
  const cur = snapshot.value?.userEq.bandsDb ?? []
  return eqDraft.value.some((v, i) => Math.abs(v - (cur[i] ?? v)) > 1e-6)
})

function onBandInput(i: number, ev: Event) {
  const v = parseFloat((ev.target as HTMLInputElement).value)
  if (Number.isNaN(v)) return
  eqDraft.value[i] = v
}

function commitBands() {
  setBands(eqDraft.value)
}

function resetBands() {
  const cur = snapshot.value?.userEq.bandsDb ?? []
  eqDraft.value = [...cur]
}

function setBands(bandsDb: number[]) {
  send('engine.setBands', { bandsDb })
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

async function applyCalibration() {
  const bandsDb = parseCurve(calJson.value)
  calIsError.value = bandsDb == null
  if (bandsDb == null) {
    calStatus.value = 'Need a JSON array of exactly 64 numbers.'
    return
  }
  calStatus.value = 'Applying…'
  const res = await withTimeout(request<OkReply>('calibration.apply', { bandsDb }), 15_000)
  if (!res) {
    calIsError.value = true
    calStatus.value = 'TV did not answer within 15s.'
    return
  }
  const payload = res.payload as OkReply
  calIsError.value = payload.ok === false
  calStatus.value = payload.ok === false ? `Device rejected curve: ${payload.error ?? 'unknown'}` : 'Curve applied.'
  void request('state.get')
}

async function resetCalibration() {
  calStatus.value = 'Resetting…'
  await withTimeout(request('calibration.reset'), 15_000)
  calStatus.value = 'Calibration reset.'
  void request('state.get')
}

function getState() {
  request('state.get')
}

function startMeasurement() {
  if (!snapshot.value?.capabilities.supportsSweep) return
  void startMeasurementSession()
}

function settingLabel(value: boolean | null): string {
  return value == null ? 'not exposed' : value ? 'on' : 'off'
}

function dbfs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '−∞ dBFS'
  return `${(20 * Math.log10(value)).toFixed(1)} dBFS`
}

function responsePolyline(points: ResponsePoint[]): string {
  if (points.length === 0) return ''
  return points.map((point) => {
    const frequencyPosition = Math.log10(point.frequencyHz / 20) / Math.log10(20_000 / 20)
    const boundedPosition = Math.max(0, Math.min(1, frequencyPosition))
    const y = 268 - Math.max(0, Math.min(1, (point.magnitudeDb + 12) / 24)) * 252
    return `${(boundedPosition * 800).toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
}

const virtualizerOn = ref(false)

async function setVirtualizer(on: boolean) {
  virtualizerOn.value = on
  await withTimeout(request(`virtualizer.${on ? 'on' : 'off'}`), 10_000)
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
  const bands = Math.max(1, Math.min(64, Math.round(persistBands.value || 64)))
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

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '?'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytes
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v.toFixed(u === 0 ? 0 : 1)} ${units[u]}`
}

watchEffect(() => {
  if (codeValid.value && status.value === 'disconnected') connect()
})
</script>

<style scoped>
.page {
  --bg: #0a0a0b;
  --ink: #ececea;
  --dim: #85858a;
  --faint: #4c4c52;
  --line: #232327;
  --line-strong: #3a3a40;
  max-width: 46rem;
  margin: 0 auto;
  padding: 3rem 1.25rem 4rem;
  background: var(--bg);
  min-height: 100vh;
  color: var(--ink);
  font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.65;
  letter-spacing: 0.01em;
}

.masthead {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
  padding-bottom: 1.25rem;
  border-bottom: 1px solid var(--ink);
}
.brand h1 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: 0.45em;
}
.sub {
  margin: 0.15rem 0 0;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  color: var(--dim);
}
.conn {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--dim);
  white-space: nowrap;
}
.conn-dot {
  width: 7px;
  height: 7px;
  background: var(--faint);
}
.conn[data-state='connected'] .conn-dot {
  background: var(--ink);
}
.conn[data-state='connected'] .conn-label {
  color: var(--ink);
}
.conn[data-state='offline'] .conn-dot {
  background: var(--ink);
}
.conn[data-state='offline'] .conn-label {
  color: var(--ink);
}
.toast {
  position: fixed;
  top: 1rem;
  left: 50%;
  z-index: 10;
  width: min(32rem, calc(100vw - 2rem));
  padding: 0.8rem 1rem;
  transform: translateX(-50%);
  border: 1px solid var(--ink);
  background: var(--bg);
  color: var(--ink);
  text-align: center;
  box-shadow: 0 0.5rem 2rem rgba(0, 0, 0, 0.35);
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, -0.5rem);
}

.block {
  padding: 1.75rem 0;
  border-bottom: 1px solid var(--line);
}
.label {
  margin: 0 0 1rem;
  font-size: 0.68rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.22em;
  color: var(--dim);
}
.sub-label {
  margin: 1.5rem 0 0.4rem;
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.16em;
}
.response-graph {
  margin-top: 1.25rem;
  border-top: 1px solid var(--line);
  padding-top: 1rem;
}
.response-graph svg {
  display: block;
  width: 100%;
  height: auto;
  margin: 0.5rem 0 1rem;
  background: #0d0d0f;
  border: 1px solid var(--line);
}
.graph-zero {
  stroke: var(--line-strong);
  stroke-width: 1;
  stroke-dasharray: 4 5;
}
.graph-line {
  fill: none;
  stroke: var(--ink);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}
.graph-label {
  fill: var(--dim);
  font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.note {
  margin: 0.35rem 0;
  font-size: 0.72rem;
  color: var(--dim);
}
.error {
  margin: 0;
  color: var(--ink);
  text-decoration: underline;
  text-underline-offset: 4px;
  text-decoration-color: var(--dim);
}
.dim {
  color: var(--faint);
}
.mark {
  color: var(--dim);
}

.spec {
  display: grid;
  grid-template-columns: 11rem 1fr;
  row-gap: 0.3rem;
  column-gap: 1rem;
  margin: 0;
}
.spec.wide {
  grid-template-columns: 8rem 1fr;
  margin-top: 1rem;
}
.spec dt {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--dim);
}
.spec dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 0.75rem 0;
}
button {
  padding: 0.42rem 0.95rem;
  background: transparent;
  border: 1px solid var(--line-strong);
  color: var(--ink);
  font: inherit;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
button:hover:not(:disabled),
button:focus-visible {
  background: var(--ink);
  border-color: var(--ink);
  color: var(--bg);
  outline: none;
}
button:active:not(:disabled) {
  background: var(--dim);
  border-color: var(--dim);
}
button:disabled {
  opacity: 0.35;
  cursor: default;
}
button.active {
  background: var(--ink);
  border-color: var(--ink);
  color: var(--bg);
}

input[type='text'],
input[type='number'],
textarea {
  padding: 0.42rem 0.6rem;
  background: transparent;
  border: 1px solid var(--line);
  color: var(--ink);
  font: inherit;
  font-size: 0.78rem;
}
input:focus-visible,
textarea:focus-visible {
  outline: none;
  border-color: var(--dim);
}
textarea {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  display: block;
  margin-bottom: 0.6rem;
}

.inline-form {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  margin: 0.75rem 0;
}
.inline-form input[type='text'] {
  flex: 1;
  min-width: 12rem;
}
.inline-form input[type='number'] {
  width: 5rem;
}

.band-scroll {
  display: flex;
  gap: 0.35rem;
  overflow-x: auto;
  padding: 1rem 0 0.5rem;
}
.band {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  min-width: 2.6rem;
}
.band-val {
  font-size: 0.62rem;
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}
.band-hz {
  font-size: 0.6rem;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}
input[type='range'] {
  writing-mode: vertical-lr;
  direction: rtl;
  width: 18px;
  height: 120px;
  appearance: none;
  background: transparent;
  padding: 0;
}
input[type='range']::-webkit-slider-runnable-track {
  width: 1px;
  background: var(--line-strong);
}
input[type='range']::-webkit-slider-thumb {
  appearance: none;
  width: 11px;
  height: 5px;
  margin-left: -5px;
  background: var(--ink);
  border: none;
  border-radius: 0;
  cursor: ns-resize;
}
input[type='range']::-moz-range-track {
  width: 1px;
  background: var(--line-strong);
}
input[type='range']::-moz-range-thumb {
  width: 11px;
  height: 5px;
  background: var(--ink);
  border: none;
  border-radius: 0;
  cursor: ns-resize;
}

.list {
  list-style: none;
  margin: 0.5rem 0 0;
  padding: 0;
}
.list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.45rem 0;
  border-top: 1px solid var(--line);
}
.list-actions {
  display: flex;
  gap: 0.4rem;
}
.list-actions button {
  padding: 0.25rem 0.6rem;
}

.grid {
  width: 100%;
  border-collapse: collapse;
  margin: 0.75rem 0;
  font-size: 0.74rem;
}
.grid th {
  text-align: left;
  font-weight: 500;
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--dim);
  padding: 0.3rem 0.6rem 0.3rem 0;
  border-bottom: 1px solid var(--ink);
}
.grid td {
  padding: 0.35rem 0.6rem 0.35rem 0;
  border-bottom: 1px solid var(--line);
  font-variant-numeric: tabular-nums;
}

.fold summary {
  cursor: pointer;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--dim);
  user-select: none;
  padding: 0.3rem 0;
}
.fold[open] summary {
  color: var(--ink);
}
.fold textarea {
  margin-top: 0.6rem;
}

.log {
  max-height: 22rem;
  overflow-y: auto;
  margin: 0.5rem 0 0;
  padding: 0.6rem;
  border: 1px solid var(--line);
  white-space: pre-wrap;
  font-size: 0.66rem;
  line-height: 1.5;
  color: var(--dim);
}

.colophon {
  display: flex;
  justify-content: space-between;
  padding-top: 1.25rem;
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  color: var(--faint);
}
</style>
