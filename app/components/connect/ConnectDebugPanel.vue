<script setup lang="ts">
import type { TransportDiagnosticsPayload } from '#shared/types/protocol'
import type { ConnectDebugLogEntry } from './types'
import type { TransportDiagnostics } from '~/lib/transport/types'

const props = defineProps<{
  entries: readonly ConnectDebugLogEntry[]
  browserDiagnostics: TransportDiagnostics | null
  tvDiagnostics: TransportDiagnosticsPayload | null
}>()

const emit = defineEmits<{
  (event: 'refresh-transport-diagnostics'): void
}>()

function formatEntries(entries: readonly ConnectDebugLogEntry[]): string {
  return entries.map((entry) =>
    new Date(entry.at).toISOString() + ' ' + entry.direction.toUpperCase() + ' ' + entry.text,
  ).join('\n')
}

function redactSession(value: string | null): string {
  return value ? `…${value.slice(-8)}` : '—'
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatMs(value: number | null): string {
  return value == null || !Number.isFinite(value) ? '—' : `${Math.round(value)} ms`
}
</script>

<template>
  <details class="block fold">
    <summary>Debug log · {{ props.entries.length }}</summary>
    <div class="actions">
      <button type="button" @click="emit('refresh-transport-diagnostics')">Refresh transport diagnostics</button>
    </div>
    <dl v-if="props.browserDiagnostics" class="spec">
      <dt>browser peer</dt><dd>{{ props.browserDiagnostics.state }}</dd>
      <dt>browser session</dt><dd>{{ redactSession(props.browserDiagnostics.sessionId) }}</dd>
      <dt>ICE / peer</dt><dd>{{ props.browserDiagnostics.iceConnectionState ?? '—' }} / {{ props.browserDiagnostics.peerConnectionState ?? '—' }}</dd>
      <dt>candidate</dt><dd>{{ props.browserDiagnostics.selectedCandidateType ?? '—' }} / {{ props.browserDiagnostics.selectedCandidateProtocol ?? '—' }}</dd>
      <dt>RTT</dt><dd>{{ formatMs(props.browserDiagnostics.rttMs) }}</dd>
      <dt>traffic</dt><dd>{{ formatBytes(props.browserDiagnostics.bytesSent) }} sent / {{ formatBytes(props.browserDiagnostics.bytesReceived) }} received</dd>
      <dt>capture buffer</dt><dd>{{ formatBytes(props.browserDiagnostics.captureBufferedBytes) }}</dd>
      <dt>reconnects</dt><dd>{{ props.browserDiagnostics.reconnectCount }}</dd>
    </dl>
    <dl v-if="props.tvDiagnostics" class="spec">
      <dt>TV peer</dt><dd>{{ props.tvDiagnostics.state }}</dd>
      <dt>TV session</dt><dd>{{ redactSession(props.tvDiagnostics.sessionId) }}</dd>
      <dt>TV ICE / peer</dt><dd>{{ props.tvDiagnostics.iceConnectionState ?? '—' }} / {{ props.tvDiagnostics.peerConnectionState ?? '—' }}</dd>
      <dt>TV traffic</dt><dd>{{ formatBytes(props.tvDiagnostics.bytesSent) }} sent / {{ formatBytes(props.tvDiagnostics.bytesReceived) }} received</dd>
      <dt>TV capture buffer</dt><dd>{{ formatBytes(props.tvDiagnostics.captureBufferedBytes) }}</dd>
      <dt>TV reconnects</dt><dd>{{ props.tvDiagnostics.reconnectCount }}</dd>
    </dl>
    <pre class="log">{{ formatEntries(props.entries) }}</pre>
  </details>
</template>
