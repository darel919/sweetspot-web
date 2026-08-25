<script setup lang="ts">
import type { CalibrationStage } from '~/composables/useCalibrationSession'
import type { MeasurementContext } from '#shared/types/protocol'

const props = defineProps<{
  stage: CalibrationStage
  message: string
  currentContext: MeasurementContext | null
  progress: { current: number; total: number }
  estimatedRemainingSeconds: number | null
  canCancel: boolean
}>()

const emit = defineEmits<{
  (event: 'cancel-measurement'): void
}>()

function remainingLabel(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return 'estimating time remaining'
  const rounded = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(rounded / 60)
  const remainder = rounded % 60
  return minutes > 0 ? `${minutes}m ${remainder}s remaining` : `${remainder}s remaining`
}

function stageLabel(stage: CalibrationStage): string {
  if (stage === 'requesting-microphone') return 'Starting calibration'
  if (stage === 'preparing' || stage === 'loudness' || stage === 'position-pause') return 'Waiting for the TV'
  if (stage === 'recording') return 'Measuring'
  if (stage === 'analyzing') return 'Analyzing'
  if (stage === 'ending') return 'Finishing calibration'
  return 'Calibration'
}
</script>

<template>
  <div class="calibration-overlay" role="dialog" aria-modal="true" aria-labelledby="calibration-overlay-title">
    <div class="calibration-shell">
      <p class="mini-label">SweetSpot / advanced calibration</p>
      <h1 id="calibration-overlay-title">{{ stageLabel(props.stage) }}</h1>

      <p class="calibration-primary">Follow the instructions on your TV</p>
      <p class="calibration-phone-note">Keep this page open. Your iPhone microphone is being used for the measurement.</p>

      <div class="calibration-progress" aria-live="polite">
        <p class="calibration-progress-count">
          Positions measured {{ Math.min(props.progress.current, props.progress.total) }} of {{ props.progress.total || '—' }}
        </p>
        <p class="calibration-progress-time">{{ remainingLabel(props.estimatedRemainingSeconds) }}</p>
      </div>

      <p v-if="props.currentContext" class="calibration-take" aria-live="polite">
        Position {{ props.currentContext.positionIndex + 1 }} of {{ props.currentContext.positionCount }} ·
        {{ props.currentContext.repairChannel === 'both' ? 'Keep the phone still' : 'Repeating this position' }}
      </p>

      <p v-if="props.message" class="calibration-message" aria-live="polite">{{ props.message }}</p>

      <div class="calibration-actions">
        <button v-if="props.canCancel" class="calibration-cancel" type="button" @click="emit('cancel-measurement')">
          Cancel calibration
        </button>
      </div>

      <p class="calibration-note">The response graph will appear when calibration ends.</p>
    </div>
  </div>
</template>

<style scoped>
.calibration-overlay {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: grid;
  place-items: center;
  overflow: auto;
  padding: max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left));
  background: rgba(7, 7, 9, 0.98);
  color: var(--ink);
}

.calibration-shell {
  width: min(100%, 34rem);
  padding: 1.25rem;
  border: 1px solid var(--line-strong);
  background: var(--panel, #111114);
}

.calibration-shell h1 {
  margin: 0.4rem 0 1.25rem;
  font-size: clamp(1.7rem, 7vw, 2.5rem);
  line-height: 1.05;
}

.calibration-progress {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  padding: 0.8rem 0;
}

.calibration-progress p,
.calibration-message,
.calibration-note,
.calibration-primary,
.calibration-phone-note {
  margin: 0;
}

.calibration-progress-count,
.calibration-position {
  color: var(--ink);
  font-weight: 600;
}

.calibration-progress-time,
.calibration-note {
  color: var(--dim);
}

.calibration-primary {
  margin-top: 1.25rem;
  font-size: 1.35rem;
  font-weight: 700;
}

.calibration-phone-note {
  margin-top: 0.5rem;
  color: var(--dim);
}

.calibration-message {
  margin-top: 1rem;
  white-space: pre-line;
}

.calibration-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.65rem;
  margin-top: 1.5rem;
}

.calibration-actions button {
  min-height: 2.9rem;
}

.calibration-cancel {
  border-color: var(--line-strong);
  background: transparent;
}

.calibration-note {
  margin-top: 1.25rem;
  font-size: 0.88rem;
}
</style>
