<script setup lang="ts">
import type { AggregateResponse, MeasurementRecord, RepeatabilitySummary } from '~/lib/audio/measurement/aggregation'
import type { CalibrationPosition } from '~/lib/audio/measurement/plan'
import type { MeasurementAnalysis } from '~/lib/audio/measurement/response'
import type { MicCalibrationProfile } from '~/lib/audio/mics/types'
import type { CalibrationStage } from '~/composables/useCalibrationSession'
import type { CorrectionStrength } from '~/lib/audio/correction/optimizer'
import type { MeasurementContext, MeasurementDiagnosticsValues, StateSnapshot } from '#shared/types/protocol'
import ConnectResponseGraph from './ConnectResponseGraph.vue'
import type {
  CalibrationValidationStatus,
  CalibrationCaptureInfo,
  CalibrationValidationMetrics,
  CorrectionStrengthOption,
  RecommendedCorrection,
} from './types'
import { computed } from 'vue'

const props = defineProps<{
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
  measurementFailedGroups: readonly RepeatabilitySummary[]
  measurementCurrentPosition: CalibrationPosition | null
  measurementProgress: { current: number; total: number }
  measurementCaptureInfo: CalibrationCaptureInfo | null
  measurementFailedDiagnostics: ReadonlyArray<{ context: MeasurementContext; diagnostics: MeasurementDiagnosticsValues }>
  measurementProfiles: readonly MicCalibrationProfile[]
  measurementSelectedProfileId: string
  measurementProfileError: string
  recommendedCorrection: RecommendedCorrection | null
  correctionStrength: CorrectionStrength
  correctionStrengthOptions: readonly CorrectionStrengthOption[]
  correctionPending: boolean
  calibrationApplied: boolean
  rollbackAvailable: boolean
  validationWorse: boolean
  candidatePending: boolean
  candidateValidationStatus: CalibrationValidationStatus | null
  validationReady: boolean
  calJson: string
  calStatus: string
  validationMetrics: CalibrationValidationMetrics | null
}>()

const selectedCapturePathStatus = computed(() =>
  props.measurementProfiles.find((profile) => profile.id === props.measurementSelectedProfileId)?.capturePathStatus ?? null,
)

const emit = defineEmits<{
  (event: 'select-profile', profileId: string): void
  (event: 'select-strength', strength: CorrectionStrength): void
  (event: 'edit-curve', value: string): void
  (event: 'start-measurement'): void
  (event: 'confirm-loudness'): void
  (event: 'continue-measurement'): void
  (event: 'cancel-measurement'): void
  (event: 'retry-failed-groups'): void
  (event: 'start-validation'): void
  (event: 'apply-recommended-correction'): void
  (event: 'apply-calibration'): void
  (event: 'reset-calibration'): void
  (event: 'rollback-calibration'): void
  (event: 'accept-candidate'): void
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

function curveRange(curve: readonly number[] | undefined): string {
  if (!curve || curve.length === 0) return 'unknown'
  return `${Math.min(...curve).toFixed(1)} to ${Math.max(...curve).toFixed(1)} dB`
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
    <p v-if="selectedCapturePathStatus" class="note">
      Capture profile status:
      {{ selectedCapturePathStatus.toUpperCase() }}.
      Only validated capture paths can produce automatic correction; unvalidated paths remain diagnostic-only.
    </p>
    <p v-if="measurementProfileError" class="error">{{ measurementProfileError }}</p>
    <p v-else-if="!measurementProfiles.length" class="note">Loading microphone profiles…</p>
    <p v-if="!snapshot.capabilities.supportsSweep" class="note">
      This TV build does not advertise a target-validated sweep yet. Calibration is unavailable until the real TV output path has been tested.
    </p>
    <p v-if="snapshot.capabilities.supportsCalibratedCorrection !== true" class="note">
      Automatic correction is withheld until this TV's 64-band transfer functions have been characterized on the real playback path. Measurement remains available for diagnostics; independent L/R correction also requires acoustic routing verification.
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
    <ul v-if="measurementFailedDiagnostics.length" class="calibration-failures">
      <li v-for="failure in measurementFailedDiagnostics" :key="`${failure.context.positionId}:${failure.context.channel}:${failure.context.takeIndex}`">
        Failed {{ failure.context.positionId }} / {{ failure.context.channel }} take {{ failure.context.takeIndex + 1 }}:
        {{ failure.diagnostics.failureReason ?? failure.diagnostics.analysisStatus ?? 'measurement error' }};
        marker {{ failure.diagnostics.syncMarkerConfidence.toFixed(2) }},
        ending marker {{ failure.diagnostics.endingMarkerConfidence.toFixed(2) }},
        drift {{ failure.diagnostics.clockDriftPpm == null ? 'unknown' : failure.diagnostics.clockDriftPpm.toFixed(0) + ' ppm' }},
        SNR {{ failure.diagnostics.snrEstimateDb == null ? 'unknown' : failure.diagnostics.snrEstimateDb.toFixed(1) + ' dB' }},
        clipping {{ failure.diagnostics.clipped ? 'yes' : 'no' }}.
      </li>
    </ul>
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
      v-if="measurementStage === 'complete' && measurementAnalysis"
      :analysis="measurementAnalysis"
      :aggregate-left="measurementAggregateLeft"
      :aggregate-right="measurementAggregateRight"
    />

    <div v-if="measurementStage === 'complete' && (measurementAggregateLeft || measurementAggregateRight)" class="response-graph">
      <p class="mini-label">Advanced result: left/right robust spatial aggregates</p>
      <p :class="measurementRepeatabilityPassed ? 'calibration-result calibration-result-good' : 'calibration-result calibration-result-failed'">
        {{ candidatePending
          ? `VALIDATION ${(candidateValidationStatus ?? 'pending').toUpperCase()}`
          : measurementRepeatabilityPassed ? 'CALIBRATION COMPLETE' : 'CALIBRATION FAILED — measurements were not repeatable' }}
      </p>
      <dl class="spec">
        <dt>repeatability</dt>
        <dd>{{ measurementRepeatabilityPassed ? 'passed' : 'failed — do not apply correction' }}</dd>
        <dt>left takes</dt><dd>{{ measurementAggregateLeft?.records.length ?? 0 }}</dd>
        <dt>right takes</dt><dd>{{ measurementAggregateRight?.records.length ?? 0 }}</dd>
        <dt>relative L/R broadband level</dt>
        <dd>
          {{ measurementAggregateLeft?.broadbandLevelDb !== null && measurementAggregateRight?.broadbandLevelDb !== null
            ? (measurementAggregateLeft.broadbandLevelDb - measurementAggregateRight.broadbandLevelDb).toFixed(1) + ' dB (left minus right; relative only)'
            : 'inconclusive' }}
        </dd>
        <dt>room readings</dt><dd>{{ measurementRecords.length }}</dd>
      </dl>
      <ul v-if="measurementFailedGroups.length" class="calibration-failures">
        <li v-for="failure in measurementFailedGroups" :key="`${failure.positionId}:${failure.channel}`">
          <template v-if="failure.failureReason === 'insufficient_takes'">
            {{ failure.positionId }} / {{ failure.channel }}. Only {{ failure.takeCount }} of {{ failure.expectedTakeCount }} takes were valid; failed takes {{ failure.failedTakeIndices.map((index) => index + 1).join(', ') }}.
          </template>
          <template v-else>
            {{ failure.positionId }} / {{ failure.channel }}. Median spread {{ failure.medianSpreadDb.toFixed(1) }} dB, maximum {{ failure.maxSpreadDb.toFixed(1) }} dB, {{ Math.round(failure.withinTwoDbFraction * 100) }}% within 2 dB.
          </template>
        </li>
      </ul>
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
        <button
          v-if="measurementFailedGroups.length"
          :disabled="correctionPending"
          @click="emit('retry-failed-groups')"
        >
          Retry failed position/channel groups
        </button>
      </div>
      <div class="actions">
        <button
          :disabled="!recommendedCorrection || !measurementRepeatabilityPassed || correctionPending || snapshot.capabilities.supportsCalibratedCorrection !== true"
          @click="emit('apply-recommended-correction')"
        >
          {{ correctionPending ? 'Applying…' : 'Apply recommended correction' }}
        </button>
        <button v-if="calibrationApplied && candidatePending" :disabled="measurementBusy || !validationReady || snapshot.calibration.liveDspStatus !== 'verified'" @click="emit('start-validation')">
          Run validation sweep
        </button>
      </div>
      <p v-if="recommendedCorrection" class="note">
        {{ recommendedCorrection.independent ? 'Independent left/right curves' : 'Common curve fallback' }} ·
        max cut {{ recommendedCorrection.maxCutDb.toFixed(1) }} dB ·
        max boost {{ recommendedCorrection.maxBoostDb.toFixed(1) }} dB ·
        headroom {{ recommendedCorrection.headroomDb.toFixed(1) }} dB ·
        LF capability −3/−6 dB {{ recommendedCorrection.lfExtension3DbHz?.toFixed(0) ?? 'unknown' }}/{{ recommendedCorrection.lfExtension6DbHz?.toFixed(0) ?? 'unknown' }} Hz
      </p>
      <p v-if="recommendedCorrection && snapshot.capabilities.supportsHeadroomCompensation !== true" class="note">
        TV headroom could not be verified, so positive correction is disabled.
      </p>
      <p v-if="calibrationApplied && snapshot.calibration.liveDspStatus !== 'verified'" class="error">
        Live DSP readback is degraded. Validation is blocked until the TV reports a verified calibration state.
      </p>
      <p v-if="candidatePending && !validationReady" class="note">
        Validation is unavailable after a browser refresh until a repeatable center baseline is measured again.
      </p>
      <dl v-if="measurementValidationAnalysis || candidatePending" class="spec">
        <dt>validation</dt><dd>center position, adaptive repeated left/right sweeps</dd>
        <dt>validation status</dt><dd>{{ (candidateValidationStatus ?? 'pending').toUpperCase() }}</dd>
        <dt v-if="snapshot.calibration.transaction.state === 'candidate_pending' && snapshot.calibration.transaction.reason">validation reason</dt>
        <dd v-if="snapshot.calibration.transaction.state === 'candidate_pending' && snapshot.calibration.transaction.reason">{{ snapshot.calibration.transaction.reason }}</dd>
        <dt>target error before</dt><dd>{{ validationMetrics?.before.toFixed(2) ?? 'unknown' }} dB RMS</dd>
        <dt>target error after</dt><dd>{{ validationMetrics?.after.toFixed(2) ?? 'unknown' }} dB RMS</dd>
        <dt v-if="measurementValidationAnalysis">validation SNR</dt>
        <dd v-if="measurementValidationAnalysis">{{ measurementValidationAnalysis.diagnostics.snrEstimateDb == null ? 'unknown' : measurementValidationAnalysis.diagnostics.snrEstimateDb.toFixed(1) + ' dB' }}</dd>
        <template v-if="validationWorse && rollbackAvailable">
          <dt>validation decision</dt><dd class="error">Worse than the center-position baseline</dd>
        </template>
      </dl>
      <div v-if="candidatePending" class="actions">
        <button v-if="candidateValidationStatus === 'passed'" :disabled="correctionPending" @click="emit('accept-candidate')">
          Accept candidate
        </button>
        <button :disabled="correctionPending" @click="emit('rollback-calibration')">
          Roll back candidate
        </button>
      </div>
    </div>

    <div v-if="candidatePending && measurementStage !== 'complete'" class="response-graph">
      <p class="calibration-result">CALIBRATION CANDIDATE · {{ (candidateValidationStatus ?? 'pending').toUpperCase() }}</p>
      <p v-if="candidateValidationStatus === 'rolling_back'" class="note">The TV is completing the rollback. Validation and acceptance are temporarily unavailable.</p>
      <p v-else class="note">The TV retained this candidate across the browser session. Choose Validate, Accept, or Roll back.</p>
      <div class="actions">
        <button
          v-if="candidateValidationStatus !== 'rolling_back'"
          :disabled="measurementBusy || !validationReady || snapshot.calibration.liveDspStatus !== 'verified'"
          @click="emit('start-validation')"
        >
          Validate candidate
        </button>
        <button v-if="candidateValidationStatus === 'passed'" :disabled="correctionPending" @click="emit('accept-candidate')">
          Accept candidate
        </button>
        <button :disabled="correctionPending" @click="emit('rollback-calibration')">
          Roll back candidate
        </button>
      </div>
    </div>

    <dl class="spec">
      <dt>status</dt>
      <dd>{{ snapshot.calibration.active ? 'active' : 'inactive' }}</dd>
      <dt>bands</dt>
      <dd>{{ snapshot.calibration.bandsDb.length }}</dd>
      <dt>requested common</dt>
      <dd>{{ curveRange(snapshot.calibration.requestedBandsDb ?? snapshot.calibration.bandsDb) }}</dd>
      <dt>effective common</dt>
      <dd>{{ curveRange(snapshot.calibration.effectiveBandsDb ?? snapshot.calibration.bandsDb) }}</dd>
      <dt>input attenuation</dt>
      <dd>{{ snapshot.calibration.inputAttenuationDb == null ? 'unknown' : snapshot.calibration.inputAttenuationDb.toFixed(1) + ' dB' }}</dd>
      <dt>live DSP</dt>
      <dd>{{ snapshot.calibration.liveDspStatus ?? 'unknown' }}<span v-if="snapshot.calibration.applicationError"> — {{ snapshot.calibration.applicationError }}</span></dd>
    </dl>
    <details class="fold">
      <summary>Curve JSON</summary>
      <textarea :value="calJson" rows="4" spellcheck="false" @input="editCurve"></textarea>
      <div class="actions">
        <button :disabled="snapshot.capabilities.supportsCalibratedCorrection !== true" @click="emit('apply-calibration')">Apply curve</button>
        <button @click="emit('reset-calibration')">Reset to flat</button>
      </div>
      <p v-if="calStatus" class="note">{{ calStatus }}</p>
    </details>
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

.calibration-failures {
  margin: 0.75rem 0;
  padding-left: 1.2rem;
  color: #ffb48a;
}
</style>
