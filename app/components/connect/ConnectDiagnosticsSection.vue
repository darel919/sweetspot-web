<script setup lang="ts">
import type {
  DeviceInfoPayload,
  PersistentProbeState,
  ProbeDiagnostics,
} from '#shared/types/protocol'
import type { ProbeCaptureEvidence } from './types'

defineProps<{
  diagPending: boolean
  probe: ProbeDiagnostics | null
  probePending: boolean
  persistentState: PersistentProbeState | null
  probeBand: number | string
  probeGainDb: number | string
  probeLabPending: boolean
  probeLabMessage: string
  probeEvidence: readonly ProbeCaptureEvidence[]
  virtualizerOn: boolean
  deviceInfo: DeviceInfoPayload | null
  devInfoPending: boolean
}>()

const emit = defineEmits<{
  (event: 'run-effects-diagnostics'): void
  (event: 'run-capacity-probe'): void
  (event: 'set-probe-band', value: number | string): void
  (event: 'set-probe-gain-db', value: number | string): void
  (event: 'create-persistent'): void
  (event: 'release-persistent'): void
  (event: 'apply-test-curve', curve: 'hollow' | 'flat'): void
  (event: 'capture-transfer-probe'): void
  (event: 'run-routing-probe'): void
  (event: 'run-marker-probe'): void
  (event: 'run-production-spacing-marker-probe'): void
  (event: 'clear-probe-evidence'): void
  (event: 'export-probe-evidence'): void
  (event: 'set-virtualizer', enabled: boolean): void
  (event: 'fetch-device-info'): void
}>()

function readNumber(event: Event, emitName: 'set-probe-band'): void
function readNumber(event: Event, emitName: 'set-probe-gain-db'): void
function readNumber(event: Event, emitName: 'set-probe-band' | 'set-probe-gain-db') {
  if (!(event.target instanceof HTMLInputElement)) return
  const value = Number.isNaN(event.target.valueAsNumber) ? event.target.value : event.target.valueAsNumber
  if (emitName === 'set-probe-band') emit(emitName, value)
  else emit(emitName, value)
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
  return v.toFixed(u === 0 ? 0 : 1) + ' ' + units[u]
}
</script>

<template>
  <section class="block">
    <h2 class="label">04 · Diagnostics</h2>
    <p class="note">Effect-chain inventory, DynamicsProcessing capacity, and a temporary diagnostic overlay on the production session-0 effect.</p>

    <div class="actions">
      <button :disabled="diagPending" @click="emit('run-effects-diagnostics')">
        {{ diagPending ? 'Working…' : 'Effect chain' }}
      </button>
      <button :disabled="probePending" @click="emit('run-capacity-probe')">
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

    <h3 class="sub-label">64-band diagnostic overlay</h3>
    <form class="inline-form" @submit.prevent="emit('create-persistent')">
      <input :value="64" type="number" min="64" max="64" disabled />
      <button type="submit">Create 64-band diagnostic</button>
      <button type="button" @click="emit('release-persistent')">Release</button>
    </form>
    <p v-if="persistentState" class="note">
      {{ persistentState.active ? 'ACTIVE at ' + persistentState.bands + ' bands' : 'none' }}
      <template v-if="persistentState.active && persistentState.curve"> · curve {{ persistentState.curve }}</template>
      <template v-if="persistentState.curveSummary">
        · {{ persistentState.curveSummary.bandsCut }} cut / {{ persistentState.curveSummary.bandsFlat }} flat
      </template>
    </p>

    <h3 class="sub-label">Audible test curves</h3>
    <p class="note">Dramatic temporary EQ through the same live production effect. Release it after the experiment.</p>
    <div class="actions">
      <button @click="emit('apply-test-curve', 'hollow')">Hollow mids</button>
      <button @click="emit('apply-test-curve', 'flat')">Flat</button>
    </div>

    <h3 class="sub-label">Acoustic transfer / routing probe</h3>
    <p class="note">
      Diagnostic only. This applies a temporary 64-band curve, then uses the existing sweep analyzer.
      Routing uses one microphone: it captures a flat baseline, then left-only and right-only cuts at four LF/mid/HF bands while you move the same mic between fixed left/right positions.
    </p>
    <form class="inline-form" @submit.prevent="emit('capture-transfer-probe')">
      <label>band <input :value="probeBand" type="number" min="1" max="64" @input="readNumber($event, 'set-probe-band')" /></label>
      <label>gain dB <input :value="probeGainDb" type="number" min="-6" max="6" step="0.5" @input="readNumber($event, 'set-probe-gain-db')" /></label>
      <button type="submit" :disabled="probeLabPending">Capture transfer</button>
      <button type="button" :disabled="probeLabPending" @click="emit('run-routing-probe')">Run L/R routing set</button>
      <button type="button" :disabled="probeLabPending" @click="emit('run-marker-probe')">Run marker-only set</button>
      <button type="button" :disabled="probeLabPending" @click="emit('run-production-spacing-marker-probe')">Run production-spacing marker set</button>
    </form>
    <p v-if="probeLabMessage" class="note">{{ probeLabMessage }}</p>
    <div v-if="probeEvidence.length" class="actions">
      <button type="button" @click="emit('export-probe-evidence')">Export {{ probeEvidence.length }} captures</button>
      <button type="button" :disabled="probeLabPending" @click="emit('clear-probe-evidence')">Clear evidence</button>
    </div>
    <ul v-if="probeEvidence.length" class="probe-evidence">
      <li v-for="capture in probeEvidence" :key="capture.id">
        {{ capture.mode }} · {{ capture.cutChannel }} · band {{ capture.bandIndex }} · {{ capture.gainDb.toFixed(1) }} dB ·
        {{ capture.positionResponses.map((position) => position.positionId).join(', ') }} ·
        {{ capture.qualityPassed ? 'usable' : 'inconclusive' }}
      </li>
    </ul>

    <h3 class="sub-label">Virtualizer A/B</h3>
    <p class="note">Persistent session-0 Virtualizer at max strength. Toggle while playing stereo through AUX.</p>
    <div class="actions">
      <button :class="{ active: virtualizerOn }" @click="emit('set-virtualizer', true)">Virtualizer ON</button>
      <button :class="{ active: !virtualizerOn }" @click="emit('set-virtualizer', false)">Virtualizer OFF</button>
    </div>
    <p class="note">{{ virtualizerOn ? 'Widening active' : 'Bypassed' }}</p>

    <h3 class="sub-label">Device info</h3>
    <div class="actions">
      <button :disabled="devInfoPending" @click="emit('fetch-device-info')">
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
</template>
