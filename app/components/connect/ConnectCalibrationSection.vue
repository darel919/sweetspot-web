<script setup lang="ts">
import type { AggregateResponse, MeasurementRecord } from '~/lib/audio/measurement/aggregation'
import type { CalibrationPosition } from '~/lib/audio/measurement/plan'
import type { MeasurementAnalysis } from '~/lib/audio/measurement/response'
import type { MicCalibrationProfile } from '~/lib/audio/mics/types'
import type { CalibrationStage } from '~/composables/useCalibrationSession'
import type { CorrectionStrength } from '~/lib/audio/correction/optimizer'
import type { StateSnapshot } from '#shared/types/protocol'
import ConnectResponseGraph from './ConnectResponseGraph.vue'
import type {
  CalibrationCaptureInfo,
  CalibrationValidationMetrics,
  CorrectionStrengthOption,
  RecommendedCorrection,
} from './types'

defineProps<{
  snapshot: StateSnapshot
  measurementStage: CalibrationStage
  measurementBusy: boolean
  measurementMessage: string
  measurementAnalysis: MeasurementAnalysis | null
  measurementRecords: readonly MeasurementRecord[]
  measurementAggregateLeft: AggregateResponse | null
  measurementAggregateRight: AggregateResponse | null
  measurementValidationAnalysis: MeasurementAnalysis | null
  measurementRepeatabilityPassed: boolean
  measurementCurrentPosition: CalibrationPosition | null
  measurementProgress: { current: number; total: number }
  measurementCaptureInfo: CalibrationCaptureInfo | null
  measurementProfiles: readonly MicCalibrationProfile[]
  measurementSelectedProfileId: string
  measurementProfileError: string
  recommendedCorrection: RecommendedCorrection | null
  correctionStrength: CorrectionStrength
  correctionStrengthOptions: readonly CorrectionStrengthOption[]
  correctionPending: boolean
  calibrationApplied: boolean
  calJson: string
  calStatus: string
  validationMetrics: CalibrationValidationMetrics | null
}>()

const emit = defineEmits<{
  (event: 'select-profile', profileId: string): void
  (event: 'select-strength', strength: CorrectionStrength): void
  (event: 'edit-curve', value: string): void
  (event: 'start-measurement'): void
  (event: 'confirm-loudness'): void
  (event: 'continue-measurement'): void
  (event: 'cancel-measurement'): void
  (event: 'start-validation'): void
  (event: 'apply-recommended-correction'): void
  (event: 'apply-calibration'): void
  (event: 'reset-calibration'): void
}>()

function selectProfile(event: Event) {
  if (event.target instanceof HTMLSelectElement) emit('select-profile', event.target.value)
}

function editCurve(event: Event) {
  if (event.target instanceof HTMLTextAreaElement) emit('edit-curve', event.target.value)
}

function settingLabel(value: boolean | null): string {
  return value == null ? 'not exposed' : value ? 'on' : 'off'
}
</script>

<template>
  <section class="block">
    <h2 class="label">03 · Calibration</h2>
    <h3 class="sub-label">Room measurement</h3>
    <p class="note">
      Follow the instructions shown on the TV. The browser captures the microphone and analyzes the sweep locally. Raw microphone audio never leaves this browser.
    </p>
    <div v-if="measurementProfiles.length" class="actions">
      <label class="inline-form">
        <span class="mini-label">microphone profile</span>
        <select :value="measurementSelectedProfileId" :disabled="measurementBusy" @change="selectProfile">
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
        @click="emit('start-measurement')"
      >
        {{ measurementBusy ? measurementMessage : 'Start advanced calibration' }}
      </button>
      <button v-if="measurementStage === 'loudness'" @click="emit('confirm-loudness')">
        Volume set, continue
      </button>
      <button v-if="measurementStage === 'position-pause'" @click="emit('continue-measurement')">Continue</button>
      <button v-if="measurementBusy" @click="emit('cancel-measurement')">Cancel</button>
    </div>
    <p v-if="measurementMessage" class="note">{{ measurementMessage }}</p>
    <p v-if="measurementProgress.total" class="note">
      Sweep {{ measurementProgress.current }} of {{ measurementProgress.total }}
      <span v-if="measurementCurrentPosition"> · {{ measurementCurrentPosition.label }}</span>
    </p>

    <dl v-if="measurementCaptureInfo" class="spec">
      <dt>sample rate</dt><dd>{{ measurementCaptureInfo.settings.sampleRate ?? 'unknown' }} Hz</dd>
      <dt>channels</dt><dd>{{ measurementCaptureInfo.settings.channelCount ?? 'unknown' }}</dd>
      <dt>echo cancellation</dt><dd>{{ settingLabel(measurementCaptureInfo.settings.echoCancellation) }}</dd>
      <dt>noise suppression</dt><dd>{{ settingLabel(measurementCaptureInfo.settings.noiseSuppression) }}</dd>
      <dt>auto gain</dt><dd>{{ settingLabel(measurementCaptureInfo.settings.autoGainControl) }}</dd>
    </dl>

    <ConnectResponseGraph
      v-if="measurementAnalysis"
      :analysis="measurementAnalysis"
      :aggregate-left="measurementAggregateLeft"
      :aggregate-right="measurementAggregateRight"
    />

    <div v-if="measurementAggregateLeft || measurementAggregateRight" class="response-graph">
      <p class="mini-label">Advanced result: left/right robust spatial aggregates</p>
      <dl class="spec">
        <dt>repeatability</dt>
        <dd>{{ measurementRepeatabilityPassed ? 'passed' : 'not passed — do not apply correction' }}</dd>
        <dt>left takes</dt><dd>{{ measurementAggregateLeft?.records.length ?? 0 }}</dd>
        <dt>right takes</dt><dd>{{ measurementAggregateRight?.records.length ?? 0 }}</dd>
        <dt>room readings</dt><dd>{{ measurementRecords.length }}</dd>
      </dl>
      <p class="note">The curves are separate channel checks. Echo and decay metrics are diagnostic; magnitude EQ cannot remove physical reflections.</p>
      <div class="actions">
        <span class="mini-label">correction strength</span>
        <button
          v-for="strength in correctionStrengthOptions"
          :key="strength.id"
          :class="{ active: correctionStrength === strength.id }"
          @click="emit('select-strength', strength.id)"
        >
          {{ strength.label }}
        </button>
      </div>
      <div class="actions">
        <button
          :disabled="!recommendedCorrection || !measurementRepeatabilityPassed || correctionPending"
          @click="emit('apply-recommended-correction')"
        >
          {{ correctionPending ? 'Applying…' : 'Apply recommended correction' }}
        </button>
        <button v-if="calibrationApplied" :disabled="measurementBusy" @click="emit('start-validation')">
          Run validation sweep
        </button>
      </div>
      <p v-if="recommendedCorrection" class="note">
        {{ recommendedCorrection.independent ? 'Independent left/right curves' : 'Common curve fallback' }} ·
        max cut {{ recommendedCorrection.maxCutDb.toFixed(1) }} dB ·
        max boost {{ recommendedCorrection.maxBoostDb.toFixed(1) }} dB ·
        headroom {{ recommendedCorrection.headroomDb.toFixed(1) }} dB
      </p>
      <p v-if="recommendedCorrection && snapshot.capabilities.supportsHeadroomCompensation !== true" class="note">
        TV headroom could not be verified, so positive correction is disabled.
      </p>
      <dl v-if="measurementValidationAnalysis" class="spec">
        <dt>validation</dt><dd>center position, independent left/right sweeps</dd>
        <dt>target error before</dt><dd>{{ validationMetrics?.before.toFixed(2) ?? 'unknown' }} dB RMS</dd>
        <dt>target error after</dt><dd>{{ validationMetrics?.after.toFixed(2) ?? 'unknown' }} dB RMS</dd>
        <dt>validation SNR</dt><dd>{{ measurementValidationAnalysis.diagnostics.snrEstimateDb == null ? 'unknown' : measurementValidationAnalysis.diagnostics.snrEstimateDb.toFixed(1) + ' dB' }}</dd>
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
      <textarea :value="calJson" rows="4" spellcheck="false" @input="editCurve"></textarea>
      <div class="actions">
        <button @click="emit('apply-calibration')">Apply curve</button>
        <button @click="emit('reset-calibration')">Reset to flat</button>
      </div>
      <p v-if="calStatus" class="note">{{ calStatus }}</p>
    </details>
  </section>
</template>
