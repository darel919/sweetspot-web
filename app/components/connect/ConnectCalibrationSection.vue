<script setup lang="ts">
import type { AggregateResponse, MeasurementRecord, RepeatabilitySummary } from '~/lib/audio/measurement/aggregation'
import type { CalibrationPosition } from '~/lib/audio/measurement/plan'
import type { MeasurementAnalysis } from '~/lib/audio/measurement/response'
import type { MicCalibrationProfile } from '~/lib/audio/mics/types'
import type { CalibrationStage, CalibrationTakeDiagnostics } from '~/composables/useCalibrationSession'
import type { CorrectionStrength } from '~/lib/audio/correction/optimizer'
import type { CalibrationValidationStatus, MeasurementContext, MeasurementDiagnosticsValues, StateSnapshot } from '#shared/types/protocol'
import ConnectResponseGraph from './ConnectResponseGraph.vue'
import type {
  CalibrationCaptureInfo,
  CalibrationValidationMetrics,
  CalibrationResultStatus,
  CorrectionStrengthOption,
  RecommendedCorrection,
} from './types'
import { calibrationValidationStatusLabel } from '~/lib/audio/correction/calibration-result'
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
  measurementQualityPassed: boolean
  measurementFailedAttemptCount: number
  measurementCompletePositionCount: number
  webBuildSha: string
  measurementConvergenceOutcome: 'sufficient' | 'bounded' | 'insufficient' | null
  measurementFailedGroups: readonly RepeatabilitySummary[]
  measurementCurrentContext: MeasurementContext | null
  measurementCurrentPosition: CalibrationPosition | null
  measurementProgress: { current: number; total: number }
  measurementCaptureInfo: CalibrationCaptureInfo | null
  measurementTakeDiagnostics: readonly CalibrationTakeDiagnostics[]
  measurementFailedDiagnostics: ReadonlyArray<{ context: MeasurementContext; diagnostics: MeasurementDiagnosticsValues }>
  debugCaptureExportEnabled: boolean
  measurementResumeAvailable: boolean
  measurementResumePositionCount: number
  measurementResumeMessage: string
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
  calibrationFinalizationPending: boolean
  calibrationResult: CalibrationResultStatus | null
  calibrationResultMessage: string
  calibrationRollbackTargetActive: boolean | null
  calJson: string
  calStatus: string
  calibrationFilePending: boolean
  calibrationFileStatus: string
  validationMetrics: CalibrationValidationMetrics | null
}>()

const selectedCapturePathStatus = computed(() =>
  props.measurementProfiles.find((profile) => profile.id === props.measurementSelectedProfileId)?.capturePathStatus ?? null,
)

const validationStatusLabel = computed(() => calibrationValidationStatusLabel({
  candidatePending: props.candidatePending,
  candidateValidationStatus: props.candidateValidationStatus,
  calibrationResult: props.calibrationResult,
}))

const emit = defineEmits<{
  (event: 'select-profile', profileId: string): void
  (event: 'select-strength', strength: CorrectionStrength): void
  (event: 'edit-curve', value: string): void
  (event: 'start-measurement'): void
  (event: 'resume-measurement'): void
  (event: 'cancel-measurement'): void
  (event: 'retry-failed-groups'): void
  (event: 'start-validation'): void
  (event: 'apply-recommended-correction'): void
  (event: 'apply-calibration'): void
  (event: 'reset-calibration'): void
  (event: 'rollback-calibration'): void
  (event: 'accept-candidate'): void
  (event: 'download-calibration'): void
  (event: 'export-debug-bundle'): void
  (event: 'import-calibration', file: File): void
}>()

function selectProfile(event: Event) {
  if (event.target instanceof HTMLSelectElement) emit('select-profile', event.target.value)
}

function editCurve(event: Event) {
  if (event.target instanceof HTMLTextAreaElement) emit('edit-curve', event.target.value)
}

function importCalibrationFile(event: Event) {
  if (!(event.target instanceof HTMLInputElement)) return
  const file = event.target.files?.[0]
  event.target.value = ''
  if (file) emit('import-calibration', file)
}

function settingLabel(value: boolean | null): string {
  return value == null ? 'not exposed' : value ? 'on' : 'off'
}

function curveRange(curve: readonly number[] | undefined): string {
  if (!curve || curve.length === 0) return 'unknown'
  return `${Math.min(...curve).toFixed(1)} to ${Math.max(...curve).toFixed(1)} dB`
}

function captureFailureMessage(diagnostics: MeasurementDiagnosticsValues): string {
  if (typeof diagnostics.markerSeparationPpm === 'number' && diagnostics.clockDriftPpm === null) {
    return 'The marker timing was ambiguous, so SweetSpot did not call it clock drift. Keep the phone still and retry.'
  }
  switch (diagnostics.analysisStatus) {
    case 'sync_marker_not_found':
      return "SweetSpot couldn't reliably identify the TV test signal."
    case 'clock_drift_unreliable':
      return 'The TV and iPhone timing was not stable enough for this reading.'
    case 'capture_too_short':
      return 'The recording ended before the complete test signal arrived.'
    case 'capture_clipped':
      return 'The microphone clipped during this reading.'
    case 'signal_too_low':
      return 'The reading was too quiet or noisy to trust.'
    case 'sweep_not_found':
      return 'The complete test signal was not clear enough to analyze.'
    case 'direct_arrival_low_confidence':
    case 'impulse_not_found':
      return 'Synchronization succeeded, but the direct acoustic arrival was too weak to trust.'
    case 'response_not_generated':
      return 'Synchronization succeeded, but no usable response was generated.'
    default:
      return 'The reading was not clear enough to trust.'
  }
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
      <span v-if="selectedCapturePathStatus !== 'validated'">Automatic correction is disabled until this capture path is independently validated.</span>
    </p>
    <p v-if="measurementProfileError" class="error">{{ measurementProfileError }}</p>
    <p v-else-if="!measurementProfiles.length" class="note">Loading microphone profiles…</p>
    <p v-if="!snapshot.capabilities.supportsSweep" class="note">
      This TV build does not advertise a target-validated sweep yet. Calibration is unavailable until the real TV output path has been tested.
    </p>
    <p v-if="snapshot.capabilities.supportsCalibratedCorrection !== true" class="note">
      Automatic correction is unavailable because the TV's EQ readback is degraded. Measurement remains available for diagnostics.
    </p>
    <p v-else-if="snapshot.capabilities.supportsIndependentCalibration !== true" class="note">
      Common automatic correction is available. Independent left/right correction is not enabled for this TV.
    </p>
    <div class="actions">
      <button
        :disabled="!snapshot.capabilities.supportsSweep || measurementBusy || correctionPending"
        @click="emit('start-measurement')"
      >
        {{ measurementBusy ? measurementMessage : 'Start Auto Room Calibration' }}
      </button>
      <button
        v-if="measurementResumeAvailable"
        :disabled="measurementBusy || correctionPending"
        @click="emit('resume-measurement')"
      >
        Resume saved calibration ({{ measurementResumePositionCount }} positions)
      </button>
      <button v-if="measurementBusy" @click="emit('cancel-measurement')">Cancel</button>
    </div>
    <p v-if="measurementResumeMessage" class="note">{{ measurementResumeMessage }}</p>
    <p v-if="measurementMessage" class="note">{{ measurementMessage }}</p>
    <ul v-if="measurementFailedDiagnostics.length" class="calibration-failures">
      <li v-for="failure in measurementFailedDiagnostics" :key="`${failure.context.positionId}:${failure.diagnostics.channel ?? failure.context.repairChannel}`">
        {{ failure.context.positionId }} / {{ failure.diagnostics.channel ?? failure.context.repairChannel }}:
        {{ captureFailureMessage(failure.diagnostics) }}
      </li>
    </ul>
    <div v-if="debugCaptureExportEnabled" class="actions">
      <button :disabled="measurementBusy" @click="emit('export-debug-bundle')">Export raw calibration debug bundle</button>
    </div>
    <p v-if="measurementProgress.total" class="note">
      Positions measured {{ measurementProgress.current }} of {{ measurementProgress.total }}
      <span v-if="measurementCurrentPosition"> · {{ measurementCurrentPosition.label }}</span>
    </p>
    <p v-if="measurementCurrentContext" class="note calibration-take" aria-live="polite">
      Position {{ measurementCurrentContext.positionIndex + 1 }} of {{ measurementCurrentContext.positionCount }} ·
      {{ measurementCurrentContext.repairChannel === 'both' ? 'Keep the phone still' : 'Repeating this position' }}
    </p>

    <dl v-if="measurementCaptureInfo" class="spec">
      <dt>sample rate</dt><dd>{{ measurementCaptureInfo.settings.sampleRate ?? 'unknown' }} Hz</dd>
      <dt>web build</dt><dd>{{ webBuildSha }}</dd>
      <dt>TV build</dt><dd>{{ snapshot.device.buildId ?? 'unknown' }}</dd>
      <dt>channels</dt><dd>{{ measurementCaptureInfo.settings.channelCount ?? 'unknown' }}</dd>
      <dt>expected capture</dt><dd>{{ measurementCaptureInfo.expectedSampleCount ?? 'unknown' }} samples{{ measurementCaptureInfo.expectedDurationMs == null ? '' : ` / ${Math.round(measurementCaptureInfo.expectedDurationMs)} ms` }}</dd>
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
      <p v-if="calibrationResult && !candidatePending" :class="`calibration-result calibration-result-${calibrationResult}`">
        {{ calibrationResult.toUpperCase() }}
      </p>
      <p v-else :class="measurementQualityPassed && measurementConvergenceOutcome === 'sufficient' ? 'calibration-result calibration-result-good' : 'calibration-result calibration-result-failed'">
        {{ candidatePending
          ? `VALIDATION ${(candidateValidationStatus ?? 'pending').toUpperCase()}`
          : measurementConvergenceOutcome === 'bounded' ? 'INCONCLUSIVE — CONVERGENCE NOT REACHED'
            : measurementQualityPassed && measurementConvergenceOutcome === 'sufficient' ? 'CALIBRATION COMPLETE'
              : 'CALIBRATION FAILED — accepted position evidence was incomplete' }}
      </p>
      <p v-if="calibrationResultMessage" class="note">{{ calibrationResultMessage }}</p>
      <dl v-if="calibrationResult && !candidatePending" class="spec">
        <dt>calibration status</dt><dd>{{ snapshot.calibration.active ? 'ACTIVE' : 'OFF' }}</dd>
        <dt>pre-candidate state</dt>
        <dd>{{ calibrationRollbackTargetActive === null ? 'unknown' : calibrationRollbackTargetActive ? 'Previously committed calibration was active' : 'No calibration was active' }}</dd>
        <dt>result</dt>
        <dd>{{ calibrationResult === 'improved' ? 'Candidate accepted' : calibrationResult === 'error' ? 'Final state not verified' : 'Candidate removed; original live state kept' }}</dd>
      </dl>
      <dl class="spec">
        <dt>capture quality</dt>
        <dd>{{ measurementQualityPassed ? 'complete' : 'incomplete — do not apply correction' }}</dd>
        <dt>historical rejected attempts</dt><dd>{{ measurementFailedAttemptCount }}</dd>
        <dt>unresolved failures</dt><dd>{{ measurementFailedDiagnostics.length }}</dd>
        <dt>complete L/R positions</dt><dd>{{ measurementCompletePositionCount }}</dd>
        <dt>planner convergence</dt><dd>{{ measurementConvergenceOutcome ?? 'not available' }}</dd>
        <dt>left readings</dt><dd>{{ measurementAggregateLeft?.records.length ?? 0 }}</dd>
        <dt>right readings</dt><dd>{{ measurementAggregateRight?.records.length ?? 0 }}</dd>
        <dt>relative L/R broadband level</dt>
        <dd>
          {{ measurementAggregateLeft && measurementAggregateRight && measurementAggregateLeft.broadbandLevelDb !== null && measurementAggregateRight.broadbandLevelDb !== null
            ? (measurementAggregateLeft.broadbandLevelDb - measurementAggregateRight.broadbandLevelDb).toFixed(1) + ' dB (left minus right; relative only)'
            : 'inconclusive' }}
        </dd>
        <dt>room readings</dt><dd>{{ measurementRecords.length }}</dd>
      </dl>
      <ul v-if="measurementFailedGroups.length" class="calibration-failures">
        <li v-for="failure in measurementFailedGroups" :key="`${failure.positionId}:${failure.channel}`">
          <template v-if="failure.failureReason === 'capture_rejected'">
            {{ failure.positionId }} / {{ failure.channel }} was not usable. A targeted retry may be needed.
          </template>
          <template v-else>
            {{ failure.positionId }} / {{ failure.channel }}. Median spatial spread {{ failure.medianSpreadDb == null ? 'unknown' : failure.medianSpreadDb.toFixed(1) }} dB, maximum {{ failure.maxSpreadDb == null ? 'unknown' : failure.maxSpreadDb.toFixed(1) }} dB, {{ failure.withinTwoDbFraction == null ? 'unknown' : Math.round(failure.withinTwoDbFraction * 100) + '%' }} within 2 dB.
          </template>
        </li>
      </ul>
      <details v-if="measurementTakeDiagnostics.length" class="developer-diagnostics">
        <summary>Developer diagnostics, {{ measurementTakeDiagnostics.length }} physical take{{ measurementTakeDiagnostics.length === 1 ? '' : 's' }}</summary>
        <div class="table-scroll">
          <table>
            <thead>
              <tr><th>position</th><th>channel</th><th>attempt</th><th>peak</th><th>SNR</th><th>start marker</th><th>end marker</th><th>drift</th><th>direct ratio</th><th>candidate / accepted</th><th>decision</th><th>status</th></tr>
            </thead>
            <tbody>
              <template v-for="take in measurementTakeDiagnostics" :key="`${take.context.positionId}:${take.context.attemptIndex}`">
                <tr v-for="channel in [take.left, take.right]" :key="`${take.context.positionId}:${take.context.attemptIndex}:${channel.channel}`">
                  <td>{{ take.context.positionId }}</td>
                  <td>{{ channel.channel }}</td>
                  <td>{{ take.context.attemptIndex + 1 }}/{{ take.context.attemptCount }}</td>
                  <td>{{ channel.signalPeak == null ? 'unknown' : channel.signalPeak.toFixed(3) }}</td>
                  <td>{{ channel.snrEstimateDb == null ? 'unknown' : `${channel.snrEstimateDb.toFixed(1)} dB` }}</td>
                  <td>{{ channel.rawLeadingMarkerConfidence == null ? 'unknown' : channel.rawLeadingMarkerConfidence.toFixed(2) }}</td>
                  <td>{{ channel.rawTrailingMarkerConfidence == null ? 'unknown' : channel.rawTrailingMarkerConfidence.toFixed(2) }}</td>
                  <td>{{ channel.clockDriftPpm == null ? 'unknown' : `${channel.clockDriftPpm.toFixed(1)} ppm` }}</td>
                  <td>{{ channel.directPeakToNoiseDb == null ? 'unknown' : `${channel.directPeakToNoiseDb.toFixed(1)} dB` }}</td>
                  <td>{{ channel.directArrivalCandidateSample ?? 'none' }} / {{ channel.directArrivalAcceptedSample ?? 'none' }}</td>
                  <td>{{ channel.directArrivalRejectionReason ?? 'accepted' }}</td>
                  <td>{{ channel.analysisStatus }}</td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </details>
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
          v-if="measurementFailedGroups.length || measurementFailedDiagnostics.length"
          :disabled="correctionPending"
          @click="emit('retry-failed-groups')"
        >
          Run calibration again
        </button>
      </div>
      <div class="actions">
        <button
          :disabled="!recommendedCorrection || !measurementQualityPassed || measurementConvergenceOutcome !== 'sufficient' || correctionPending || candidatePending || snapshot.capabilities.supportsCalibratedCorrection !== true"
          @click="emit('apply-recommended-correction')"
        >
          {{ correctionPending ? 'Staging…' : 'Stage recommended candidate' }}
        </button>
        <button v-if="calibrationApplied && candidatePending && !calibrationFinalizationPending" :disabled="measurementBusy || !validationReady || snapshot.calibration.liveDspStatus !== 'verified'" @click="emit('start-validation')">
          Recovery validation sweep
        </button>
      </div>
      <p v-if="recommendedCorrection" class="note">
        {{ recommendedCorrection.independent ? 'Independent left/right curves' : 'Common curve fallback' }} ·
        max cut {{ recommendedCorrection.maxCutDb.toFixed(1) }} dB ·
        max boost {{ recommendedCorrection.maxBoostDb.toFixed(1) }} dB ·
        headroom {{ recommendedCorrection.headroomDb.toFixed(1) }} dB ·
        LF capability −3/−6 dB {{ recommendedCorrection.lfExtension3DbHz?.toFixed(0) ?? 'unknown' }}/{{ recommendedCorrection.lfExtension6DbHz?.toFixed(0) ?? 'unknown' }} Hz
      </p>
      <p v-if="recommendedCorrection?.sharedLf" class="note">
        Shared bass correction: active · common correction 20–{{ recommendedCorrection.sharedLf.commonThroughHz.toFixed(0) }} Hz ·
        stereo transition {{ recommendedCorrection.sharedLf.commonThroughHz.toFixed(0) }}–{{ recommendedCorrection.sharedLf.independentFromHz.toFixed(0) }} Hz ·
        independent correction above {{ recommendedCorrection.sharedLf.independentFromHz.toFixed(0) }} Hz
      </p>
      <p v-if="recommendedCorrection && snapshot.capabilities.supportsHeadroomCompensation !== true" class="note">
        TV headroom could not be verified, so positive correction is disabled.
      </p>
      <p v-if="calibrationApplied && snapshot.calibration.liveDspStatus !== 'verified'" class="error">
        Live DSP readback is degraded. Validation is blocked until the TV reports a verified calibration state.
      </p>
      <p v-if="candidatePending && !validationReady" class="note">
        Validation is unavailable after a browser refresh until a stable spatial baseline is measured again.
      </p>
      <dl v-if="measurementValidationAnalysis || candidatePending || calibrationResult" class="spec">
        <dt>validation</dt><dd>matched physical-position left/right captures using the robust spatial objective</dd>
        <dt>validation status</dt><dd>{{ validationStatusLabel ?? 'unknown' }}</dd>
        <dt v-if="snapshot.calibration.transaction.state === 'candidate_pending' && snapshot.calibration.transaction.reason">validation reason</dt>
        <dd v-if="snapshot.calibration.transaction.state === 'candidate_pending' && snapshot.calibration.transaction.reason">{{ snapshot.calibration.transaction.reason }}</dd>
        <dt>baseline spatial error</dt><dd>{{ validationMetrics?.before.toFixed(2) ?? 'unknown' }} dB RMS</dd>
        <dt>candidate spatial error</dt><dd>{{ validationMetrics?.after.toFixed(2) ?? 'unknown' }} dB RMS</dd>
        <dt v-if="measurementValidationAnalysis">validation SNR</dt>
        <dd v-if="measurementValidationAnalysis">{{ measurementValidationAnalysis.diagnostics.snrEstimateDb == null ? 'unknown' : measurementValidationAnalysis.diagnostics.snrEstimateDb.toFixed(1) + ' dB' }}</dd>
        <template v-if="validationWorse && rollbackAvailable">
          <dt>validation decision</dt><dd class="error">Worse than the selected spatial objective</dd>
        </template>
      </dl>
      <p v-if="candidateValidationStatus === 'imported' && !calibrationFinalizationPending" class="note">
        This imported calibration is live and DSP-verified. Acoustic validation was not run on this TV. Accept it to keep it or roll it back.
      </p>
      <p v-else-if="candidatePending && !calibrationFinalizationPending" class="note">
        The normal flow validates and finalizes this candidate automatically. The controls below are recovery-only.
      </p>
      <div v-if="candidatePending && !calibrationFinalizationPending" class="actions">
        <button v-if="candidateValidationStatus === 'passed' || candidateValidationStatus === 'imported'" :disabled="correctionPending" @click="emit('accept-candidate')">
          Recovery-only accept
        </button>
        <button :disabled="correctionPending" @click="emit('rollback-calibration')">
          Recovery-only rollback
        </button>
      </div>
    </div>

    <div v-if="measurementStage === 'error' && calibrationResult" class="response-graph">
      <p :class="`calibration-result calibration-result-${calibrationResult}`">
        {{ calibrationResult.toUpperCase() }}
      </p>
      <p v-if="calibrationResultMessage" class="note">{{ calibrationResultMessage }}</p>
    </div>

    <div v-if="candidatePending && measurementStage !== 'complete'" class="response-graph">
      <p class="calibration-result">CALIBRATION CANDIDATE · {{ (candidateValidationStatus ?? 'pending').toUpperCase() }}</p>
      <p v-if="candidateValidationStatus === 'rolling_back'" class="note">The TV is completing the rollback. Validation and acceptance are temporarily unavailable.</p>
      <p v-else-if="candidateValidationStatus === 'imported'" class="note">This calibration came from a file. The TV verified the live DSP state, but room validation was not run here. Accept it to keep it or roll it back.</p>
      <p v-else-if="!calibrationFinalizationPending" class="note">The TV retained this candidate across the browser session. The normal flow validates it automatically. Recovery controls are available below.</p>
      <p v-else class="note">The TV is completing the calibration transaction. Keep this page open until it reports a final result.</p>
      <div class="actions">
        <button
          v-if="candidateValidationStatus !== 'rolling_back' && !calibrationFinalizationPending"
          :disabled="measurementBusy || !validationReady || snapshot.calibration.liveDspStatus !== 'verified'"
          @click="emit('start-validation')"
        >
          Recovery-only validate
        </button>
        <button v-if="(candidateValidationStatus === 'passed' || candidateValidationStatus === 'imported') && !calibrationFinalizationPending" :disabled="correctionPending" @click="emit('accept-candidate')">
          Recovery-only accept
        </button>
        <button v-if="!calibrationFinalizationPending" :disabled="correctionPending" @click="emit('rollback-calibration')">
          Recovery-only rollback
        </button>
      </div>
    </div>

    <div class="actions calibration-file-actions">
      <button
        :disabled="calibrationFilePending || correctionPending || candidatePending || !snapshot.calibration.active"
        @click="emit('download-calibration')"
      >
        {{ calibrationFilePending ? 'Preparing…' : 'Download TV calibration' }}
      </button>
      <label class="file-button" :class="{ disabled: calibrationFilePending || correctionPending || candidatePending }">
        Upload calibration
        <input
          type="file"
          accept="application/json,.json"
          :disabled="calibrationFilePending || correctionPending || candidatePending"
          @change="importCalibrationFile"
        />
      </label>
    </div>
    <p class="note">The file contains final TV EQ data only. Imported data is staged for explicit acceptance or rollback.</p>
    <p v-if="calibrationFileStatus" class="note">{{ calibrationFileStatus }}</p>

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
        <button :disabled="snapshot.capabilities.supportsCalibratedCorrection !== true || candidatePending" @click="emit('apply-calibration')">Stage curve candidate</button>
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

.calibration-result-improved {
  color: #a9e6b1;
}

.calibration-result-inconclusive {
  color: #f2d28c;
}

.calibration-result-cancelled {
  color: #f2d28c;
}

.calibration-result-worse,
.calibration-result-error {
  color: #ffb48a;
}

.calibration-result-failed {
  color: #ffb48a;
}

.calibration-failures {
  margin: 0.75rem 0;
  padding-left: 1.2rem;
  color: #ffb48a;
}

.calibration-file-actions {
  align-items: center;
}

.file-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2.1rem;
  padding: 0.35rem 0.7rem;
  border: 1px solid var(--line);
  cursor: pointer;
}

.file-button.disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.file-button input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
