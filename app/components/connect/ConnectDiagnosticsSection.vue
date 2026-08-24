<script setup lang="ts">
import type {
  DeviceInfoPayload,
  PersistentProbeState,
  ProbeDiagnostics,
} from '#shared/types/protocol'

defineProps<{
  diagPending: boolean
  probe: ProbeDiagnostics | null
  probePending: boolean
  persistentState: PersistentProbeState | null
  persistBands: number | string
  virtualizerOn: boolean
  deviceInfo: DeviceInfoPayload | null
  devInfoPending: boolean
}>()

const emit = defineEmits<{
  (event: 'run-effects-diagnostics'): void
  (event: 'run-capacity-probe'): void
  (event: 'set-persist-bands', value: number | string): void
  (event: 'create-persistent'): void
  (event: 'release-persistent'): void
  (event: 'apply-test-curve', curve: 'hollow' | 'flat'): void
  (event: 'quick-audible', bands: number): void
  (event: 'set-virtualizer', enabled: boolean): void
  (event: 'fetch-device-info'): void
}>()

function readPersistBands(event: Event) {
  if (!(event.target instanceof HTMLInputElement)) return
  emit('set-persist-bands', Number.isNaN(event.target.valueAsNumber) ? event.target.value : event.target.valueAsNumber)
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
    <p class="note">Upmix experiments. Effect-chain inventory, DynamicsProcessing capacity, persistent test instances.</p>

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

    <h3 class="sub-label">Persistent instance</h3>
    <form class="inline-form" @submit.prevent="emit('create-persistent')">
      <input :value="persistBands" type="number" min="1" max="64" @input="readPersistBands" />
      <button type="submit">Create enabled</button>
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
    <p class="note">Dramatic EQ through the persistent instance. Proof it sits on the live path.</p>
    <div class="actions">
      <button @click="emit('apply-test-curve', 'hollow')">Hollow mids</button>
      <button @click="emit('apply-test-curve', 'flat')">Flat</button>
      <button v-for="n in [16, 32, 64]" :key="n" @click="emit('quick-audible', n)">Hollow @ {{ n }}</button>
    </div>

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
