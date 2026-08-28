<script setup lang="ts">
import { computed } from 'vue'
import type {
  CalibrationCaptureMetadata,
  CalibrationJobStartMode,
  CalibrationJobPhase,
  CalibrationJobView,
  CalibrationNextAction,
  StateSnapshot,
} from '#shared/types/protocol'
import type { MicCalibrationProfile } from '~/lib/audio/mics/types'
import type { RemoteMicCaptureState } from '~/composables/calibration/useCalibrationRemoteMic'

const props = defineProps<{
  snapshot: StateSnapshot
  deviceOnline: boolean
  job: CalibrationJobView | null
  captureState: RemoteMicCaptureState
  captureError: string
  captureMetadata: CalibrationCaptureMetadata | null
  profiles: readonly MicCalibrationProfile[]
  selectedProfileId: string
  profileError: string
  jobStateKnown: boolean
  captureResourceReady: boolean
  captureResourceError: string
}>()

const emit = defineEmits<{
  (event: 'start', mode: CalibrationJobStartMode): void
  (event: 'resume'): void
  (event: 'cancel-capture'): void
  (event: 'cancel-refinement'): void
  (event: 'finish'): void
  (event: 'discard'): void
  (event: 'retry-upload'): void
  (event: 'retry-capture-resources'): void
  (event: 'select-profile', profileId: string): void
}>()

const terminalPhases: readonly CalibrationJobPhase[] = ['complete', 'failed', 'cancelled']
const activePhases: readonly CalibrationJobPhase[] = [
  'center_preflight',
  'measuring_required',
  'usable',
  'refining',
  'candidate_pending',
  'validating',
  'reoptimizing',
  'restoring',
]

const action = computed(() => props.job?.nextAction ?? null)
const active = computed(() => props.job !== null && activePhases.includes(props.job.phase))
const terminal = computed(() => props.job !== null && terminalPhases.includes(props.job.phase))
const canStart = computed(() => props.deviceOnline
  && props.snapshot.capabilities.supportsSweep
  && props.snapshot.capabilities.supportsCalibratedCorrection
  && props.jobStateKnown
  && props.captureResourceReady
  && !active.value
  && props.captureState === 'idle')
const canResume = computed(() => props.deviceOnline && props.captureResourceReady
  && props.jobStateKnown && props.job !== null && !terminal.value && props.captureState === 'idle')
const canRetryCapture = computed(() => props.deviceOnline && props.captureState === 'error'
  && props.captureResourceReady
  && (action.value?.kind === 'capture' || action.value?.kind === 'validate'))
const canCancelCapture = computed(() => props.captureState === 'opening'
  || props.captureState === 'recording'
  || props.captureState === 'uploading'
  || props.captureState === 'waiting')
const optionalRefinementCapture = computed(() => active.value
  && action.value?.kind === 'capture'
  && action.value.optional)
const canFinishCurrent = computed(() => active.value
  && props.job?.minimumViableCalibration
  && action.value?.kind === 'capture')
const statusText = computed(() => {
  if (!props.jobStateKnown) return 'Checking the TV’s saved calibration state…'
  if (props.captureResourceError) return props.captureResourceError
  if (!props.captureResourceReady) return 'Preparing browser microphone capture…'
  if (props.captureState === 'opening') return 'Opening the microphone…'
  if (props.captureState === 'recording') return 'Recording. Keep the phone still.'
  if (props.captureState === 'uploading') return 'Sending the recording to the TV…'
  if (props.captureState === 'waiting') return 'The TV is analyzing this recording…'
  if (props.captureState === 'error') return props.captureError
  if (!props.job) return 'Ready to measure the room.'
  if (props.job.phase === 'center_preflight') return 'Checking the center setup before the room walkaround.'
  if (props.job.phase === 'measuring_required') return 'Collecting the required center, left, and right positions.'
  if (props.job.phase === 'usable') return 'A usable correction exists. Optional positions can refine it.'
  if (props.job.phase === 'refining') return 'Checking whether another position improves confidence.'
  if (props.job.phase === 'candidate_pending' || props.job.phase === 'validating') return 'Verifying the correction at the center position.'
  if (props.job.phase === 'reoptimizing') return 'Trying a gentler correction from the saved room measurements.'
  if (props.job.phase === 'restoring') return 'Restoring the previous verified audio state.'
  if (props.job.phase === 'complete') return 'Calibration is complete and verified.'
  if (props.job.phase === 'cancelled') return 'Calibration was cancelled.'
  return props.job.lastError?.message ?? 'Calibration could not produce a usable correction.'
})

const actionInstruction = computed(() => {
  const current = action.value
  if (!current) return null
  if (current.kind === 'capture' || current.kind === 'validate') return current.instruction
  return current.kind === 'wait' ? current.message : 'Calibration is complete.'
})

const modeLabel = computed(() => {
  if (props.job?.mode === 'advanced') return 'Advanced room calibration'
  if (props.job?.mode === 'auto') return 'Auto room calibration'
  return 'Calibration mode unavailable'
})

function profileChanged(event: Event) {
  if (event.target instanceof HTMLSelectElement) emit('select-profile', event.target.value)
}

function positionLabel(position: string): string {
  return position.charAt(0).toUpperCase() + position.slice(1)
}

function confidenceLabel(): string {
  const grade = props.job?.confidence?.grade
  if (grade === 'sufficient') return 'High'
  if (grade === 'bounded_usable') return 'Conservative'
  return 'Not available'
}
</script>

<template>
  <section class="block">
    <h2 class="label">03 · Calibration</h2>
    <h3 class="sub-label">TV-owned room measurement</h3>
    <p class="note">
      The TV plays and analyzes the test signal. This browser only records the microphone and sends temporary PCM to the paired TV.
      Raw calibration audio is deleted after completion unless debug retention is enabled.
    </p>

    <div v-if="profiles.length" class="actions">
      <label class="inline-form">
        <span class="mini-label">microphone profile</span>
        <select :value="selectedProfileId" :disabled="captureState !== 'idle'" @change="profileChanged">
          <option v-for="profile in profiles" :key="profile.id" :value="profile.id">
            {{ profile.name }}
          </option>
        </select>
      </label>
    </div>
    <p v-if="profileError" class="error">{{ profileError }}</p>
    <p v-if="captureResourceError" class="error" role="alert">
      {{ captureResourceError }}
      <button class="inline-button" @click="emit('retry-capture-resources')">Retry microphone setup</button>
    </p>
    <p v-if="!snapshot.capabilities.supportsSweep" class="note">
      This TV build does not advertise a validated calibration sweep.
    </p>
    <p v-else-if="snapshot.capabilities.supportsCalibratedCorrection !== true" class="note">
      The TV cannot verify its calibration DSP, so automatic correction is unavailable.
    </p>

    <div class="actions">
      <button :disabled="!canStart" @click="emit('start', 'auto')">Start Auto Room Calibration</button>
      <button :disabled="!canStart" @click="emit('start', 'advanced')">Start Advanced Room Calibration</button>
      <button v-if="canResume" @click="emit('resume')">Resume saved calibration</button>
      <button v-if="canRetryCapture" @click="emit('retry-upload')">Retry capture</button>
      <button v-if="canCancelCapture && !(captureState === 'waiting' && optionalRefinementCapture)" @click="emit('cancel-capture')">Cancel capture</button>
      <button v-if="canFinishCurrent" :disabled="captureState === 'opening' || captureState === 'recording' || captureState === 'uploading'" @click="emit('finish')">Finish with current solution</button>
      <button v-if="optionalRefinementCapture && job?.minimumViableCalibration" :disabled="captureState !== 'idle' && captureState !== 'waiting'" @click="emit('cancel-refinement')">Stop optional refinement</button>
      <button v-if="job && !terminal" :disabled="captureState === 'uploading'" @click="emit('discard')">Discard calibration job</button>
    </div>

    <p class="note" aria-live="polite">{{ statusText }}</p>
    <p v-if="job?.lastError && captureState === 'idle'" class="error" aria-live="polite">
      TV note: {{ job.lastError.message }}
      <span v-if="job.minimumViableCalibration">The TV kept the accepted positions.</span>
    </p>
    <p v-if="actionInstruction" class="calibration-take" aria-live="polite">
      {{ actionInstruction }}
    </p>

    <dl v-if="job" class="spec">
      <dt>job</dt><dd>{{ job.jobId }}</dd>
      <dt>mode</dt><dd>{{ modeLabel }}</dd>
      <dt>phase</dt><dd>{{ job.phase.replaceAll('_', ' ') }}</dd>
      <dt>positions used</dt><dd>{{ job.acceptedPositions.map(positionLabel).join(', ') || 'none' }}</dd>
      <dt>positions excluded</dt><dd>{{ job.excludedPositions.map(positionLabel).join(', ') || 'none' }}</dd>
      <dt>historical attempts</dt><dd>{{ job.historicalAttemptCount }}</dd>
      <dt>optional failures</dt><dd>{{ job.optionalFailureCount }}</dd>
      <dt>confidence</dt><dd>{{ confidenceLabel() }}<span v-if="job.confidence"> · {{ Math.round(job.confidence.score * 100) }}%</span></dd>
      <dt>correction</dt><dd>{{ job.minimumViableCalibration ? 'ready on TV' : 'not available' }}</dd>
    </dl>

    <p v-if="job?.bestSolution" class="note">
      Best solution uses {{ job.bestSolution.sourcePositionIds.map(positionLabel).join(', ') }}.
      The TV may keep it while an optional position is retried or excluded.
    </p>
    <p v-if="job?.phase === 'complete'" class="calibration-result calibration-result-good">
      {{ modeLabel.toUpperCase() }} COMPLETE · {{ confidenceLabel().toUpperCase() }} CONFIDENCE
    </p>
    <p v-else-if="job?.phase === 'failed' && job.minimumViableCalibration" class="calibration-result calibration-result-good">
      CALIBRATION RETAINED · {{ job.lastError?.message ?? 'The TV kept the best verified room solution.' }}
    </p>
    <p v-else-if="job?.phase === 'failed'" class="calibration-result calibration-result-failed">
      NO USABLE CALIBRATION · {{ job.lastError?.message ?? 'The TV did not find enough trustworthy evidence.' }}
    </p>
  </section>
</template>

<style scoped>
.calibration-result {
  margin: 0.75rem 0;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.calibration-result-good {
  color: #a9e6b1;
}

.calibration-result-failed {
  color: #ffb48a;
}

.calibration-take {
  margin: 0.75rem 0;
  color: #f2d28c;
}
</style>
