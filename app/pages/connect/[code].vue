<template>
  <div class="page">
    <header>
      <h1>SweetSpot</h1>
      <span :class="['badge', status]">{{ status }}</span>
    </header>

    <section v-if="codeError" class="card error">
      Invalid pair code format. Scan the QR code on your TV again.
    </section>

    <template v-else>
      <section class="card">
        <h2>Device</h2>
        <dl>
          <dt>Room</dt>
          <dd>{{ room }}</dd>
          <dt>TV status</dt>
          <dd>{{ deviceOnline ? 'online' : 'offline' }}</dd>
          <dt>Last message</dt>
          <dd><pre class="last-message">{{ lastMessageText }}</pre></dd>
        </dl>
      </section>

      <section v-if="snapshot" class="card">
        <h2>State snapshot</h2>
        <pre>{{ JSON.stringify(snapshot, null, 2) }}</pre>
      </section>

      <section v-else class="card">
        <h2>State snapshot</h2>
        <p v-if="status === 'connected' && !deviceOnline">Waiting for the TV. Open SweetSpot on the TV.</p>
        <p v-else-if="status === 'connected'">
          TV is online.
          <button @click="getState">Request state</button>
          <button class="secondary" :disabled="diagPending" @click="runEffectsDiagnostics">
            {{ diagPending ? 'Diagnosing...' : 'Run effect diagnostics' }}
          </button>
        </p>
        <p v-else>Connecting...</p>
      </section>

      <section v-if="effectsDiagnostics" class="card">
        <h2>Effect diagnostics</h2>
        <p v-if="effectsDiagnostics.error" class="error">Device error: {{ effectsDiagnostics.error }}</p>
        <template v-else>
          <h3>Platform effects ({{ effectsDiagnostics.inventory.length }})</h3>
          <table v-if="effectsDiagnostics.inventory.length" class="fx-table">
            <thead>
              <tr><th>Type</th><th>Name</th><th>Mode</th><th>Vendor</th></tr>
            </thead>
            <tbody>
              <tr v-for="(e, i) in effectsDiagnostics.inventory" :key="i"
                  :class="{ vendor: e.isVendor, known: !e.isVendor }">
                <td>{{ e.typeName }}</td>
                <td>{{ e.name }}</td>
                <td>{{ e.connectMode }}</td>
                <td>{{ e.isVendor ? 'yes' : '' }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else>No effects reported.</p>

          <h3>Session-0 probes</h3>
          <dl>
            <template v-for="p in effectsDiagnostics.sessionProbes" :key="p.effectType">
              <dt>{{ p.effectType }}</dt>
              <dd>
                <span v-if="!p.constructed" class="error">failed: {{ p.exception }}</span>
                <span v-else>
                  constructed, control={{ p.hasControl }}, enabled={{ p.enabled }}
                  <code>{{ p.parameters }}</code>
                </span>
              </dd>
            </template>
          </dl>
          <details>
            <summary>Raw JSON</summary>
            <pre class="debug-log">{{ JSON.stringify(effectsDiagnostics, null, 2) }}</pre>
          </details>
        </template>
      </section>

      <details v-if="debugLog.length" class="card">
        <summary>Debug log ({{ debugLog.length }})</summary>
        <pre class="debug-log">{{ debugLog.map(l => `${new Date(l.at).toISOString()} ${l.direction.padEnd(3)} ${l.text}`).join('\n') }}</pre>
      </details>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { EffectsDiagnostics, StateSnapshot } from '#shared/types/protocol'

const route = useRoute()

const rawCode = computed(() => String(route.params.code ?? ''))
const codeValid = computed(() => /^[A-Za-z0-9]{6,10}$/.test(rawCode.value.replace(/-/g, '')))
const codeError = computed(() => !codeValid.value)
const room = computed(() => rawCode.value.toUpperCase())

const connection = useSweetSpotConnection('client', () => rawCode.value)

const { status, deviceOnline, lastMessage, debugLog, connect, request, onMessage } = connection

const snapshot = ref<StateSnapshot | null>(null)
const effectsDiagnostics = ref<EffectsDiagnostics | null>(null)
const diagPending = ref(false)
const lastMessageText = computed(() => (lastMessage.value ? JSON.stringify(lastMessage.value) : ''))

onMessage((env) => {
  if (env.type === 'state.snapshot') snapshot.value = env.payload as StateSnapshot
})

function getState() {
  request('state.get')
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

watchEffect(() => {
  if (codeValid.value && status.value === 'disconnected') connect()
})
</script>

<style scoped>
.page {
  max-width: 560px;
  margin: 2rem auto;
  padding: 0 1rem;
  font-family: system-ui, sans-serif;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.badge {
  padding: 0.2rem 0.7rem;
  border-radius: 999px;
  font-size: 0.85rem;
  background: #8883;
}
.badge.connected {
  background: #16a34a;
  color: white;
}
.badge.connecting {
  background: #d97706;
  color: white;
}
.badge.disconnected {
  background: #dc2626;
  color: white;
}
.card {
  border: 1px solid #8884;
  border-radius: 10px;
  padding: 1rem;
  margin-top: 1rem;
}
.error {
  color: #dc2626;
}
dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.35rem 1rem;
  margin: 0;
}
dt {
  font-weight: 600;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
pre {
  margin: 0;
  white-space: pre-wrap;
  font-size: 0.8rem;
}
.debug-log {
  max-height: 320px;
  overflow-y: auto;
}
.last-message {
  max-height: 120px;
  overflow-y: auto;
}
button {
  padding: 0.5rem 1rem;
  border-radius: 8px;
  border: none;
  background: #2563eb;
  color: white;
}
button.secondary {
  background: #64748b;
  margin-left: 0.5rem;
}
button:disabled {
  opacity: 0.6;
}
.fx-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}
.fx-table th,
.fx-table td {
  text-align: left;
  padding: 0.25rem 0.5rem;
  border-bottom: 1px solid #8883;
}
.fx-table tr.vendor td:first-child::after {
  content: ' *';
  color: #d97706;
  font-weight: bold;
}
h3 {
  margin: 1rem 0 0.5rem;
  font-size: 0.9rem;
}
</style>
