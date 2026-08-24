<script setup lang="ts">
import type { AggregateResponse } from '~/lib/audio/measurement/aggregation'
import type { RoomMetrics } from '~/lib/audio/measurement/impulse'
import type { MeasurementAnalysis, ResponsePoint } from '~/lib/audio/measurement/response'

defineProps<{
  analysis: MeasurementAnalysis
  aggregateLeft: AggregateResponse | null
  aggregateRight: AggregateResponse | null
}>()

function metricDb(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? 'unavailable' : `${value.toFixed(1)} dB`
}

function decayLabel(room: RoomMetrics | null | undefined): string {
  if (!room) return 'unavailable'
  const values = [room.edtMs, room.t20Ms, room.t30Ms].filter((value): value is number => value != null && Number.isFinite(value))
  if (values.length === 0) return 'unavailable'
  return `${values.map((value) => `${Math.round(value)} ms`).join(' / ')} (${room.decayConfidence})`
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
</script>

<template>
  <div class="response-graph">
    <p class="mini-label">
      {{ aggregateLeft || aggregateRight ? 'Final robust aggregate, mic-compensated relative display' : 'Measured response, mic-compensated relative display' }}
    </p>
    <svg viewBox="0 0 800 280" role="img" aria-label="Measured speaker response">
      <line x1="0" y1="140" x2="800" y2="140" class="graph-zero" />
      <polyline
        v-if="!aggregateLeft && !aggregateRight"
        :points="responsePolyline(analysis.points)"
        class="graph-line"
      />
      <polyline v-if="aggregateLeft" :points="responsePolyline(aggregateLeft.points)" class="graph-line graph-left" />
      <polyline v-if="aggregateRight" :points="responsePolyline(aggregateRight.points)" class="graph-line graph-right" />
      <text x="0" y="268" class="graph-label">20 Hz</text>
      <text x="760" y="268" class="graph-label">20 kHz</text>
      <text x="8" y="16" class="graph-label">+12 dB</text>
      <text x="8" y="154" class="graph-label">0 dB</text>
      <text x="8" y="276" class="graph-label">−12 dB</text>
    </svg>
    <dl class="spec">
      <dt>signal RMS</dt><dd>{{ dbfs(analysis.diagnostics.signalRms) }}</dd>
      <dt>peak</dt><dd>{{ dbfs(analysis.diagnostics.signalPeak) }}</dd>
      <dt>SNR</dt><dd>{{ analysis.diagnostics.snrEstimateDb == null ? 'unknown' : `${analysis.diagnostics.snrEstimateDb.toFixed(1)} dB` }}</dd>
      <dt>detected offset</dt><dd>{{ analysis.diagnostics.detectionOffsetMs?.toFixed(1) ?? 'unknown' }} ms</dd>
      <dt>clipping</dt><dd>{{ analysis.diagnostics.clipped ? 'yes' : 'no' }}</dd>
      <dt>mic profile</dt><dd>{{ analysis.micProfile.name }}</dd>
      <dt>profile author</dt><dd>{{ analysis.micProfile.author }}</dd>
      <dt>profile source</dt>
      <dd>
        <a :href="analysis.micProfile.sourceUrl" target="_blank" rel="noreferrer">
          {{ analysis.micProfile.dataMethod }}, {{ analysis.micProfile.sourceDate }}
        </a>
      </dd>
      <dt>capture path</dt><dd>{{ analysis.micProfile.capturePath }}</dd>
      <dt>direct arrival</dt><dd>{{ analysis.room?.directArrivalMs == null ? 'unknown' : `${analysis.room.directArrivalMs.toFixed(1)} ms` }}</dd>
      <dt>early reflections</dt><dd>{{ analysis.room?.earlyReflections.length ?? 0 }}</dd>
      <dt>direct / late</dt><dd>{{ metricDb(analysis.room?.directToLateDb) }}</dd>
      <dt>C50 / C80</dt><dd>{{ metricDb(analysis.room?.c50Db) }} / {{ metricDb(analysis.room?.c80Db) }}</dd>
      <dt>decay</dt><dd>{{ decayLabel(analysis.room) }}</dd>
    </dl>
  </div>
</template>

<style scoped>
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
.graph-left {
  stroke: #9fd7ff;
}
.graph-right {
  stroke: #ffb48a;
}
.graph-label {
  fill: var(--dim);
  font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
