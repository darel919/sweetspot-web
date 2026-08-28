import type { MeasurementSweep } from '#shared/types/protocol'
import { generateSweepSignal, sweepSampleParts } from '../sweep-reference'
import { fftInPlace, nextPowerOfTwo } from './fft'

interface EarlyReflection {
  delayMs: number
  levelDbRelativeToDirect: number
}

export interface RoomMetrics {
  /** Arrival index inside the recovered causal impulse response, not the recorder capture. */
  directArrivalMs: number | null
  earlyReflections: EarlyReflection[]
  /** Custom direct-to-late ratio: 0-2.5 ms energy versus energy after 50 ms. */
  directToLateDb: number | null
  c50Db: number | null
  c80Db: number | null
  edtMs: number | null
  t20Ms: number | null
  t30Ms: number | null
  decayConfidence: 'high' | 'medium' | 'low'
}

export interface ImpulseSummary {
  room: RoomMetrics
  impulseLengthSamples: number
  noiseFloorRms: number
  peak: number
  directArrival: DirectArrivalDiagnostics
}

type DirectArrivalRejectionReason =
  | 'no_candidate'
  | 'peak_below_noise'
  | 'candidate_not_sustained'

interface DirectArrivalDiagnostics {
  directPeak: number
  noiseFloorRms: number
  peakToNoiseDb: number | null
  acceptanceThreshold: number
  candidateArrivalIndex: number | null
  acceptedArrivalIndex: number | null
  rejectionReason: DirectArrivalRejectionReason | null
  supportWindowRms: number | null
  supportWindowThreshold: number | null
  supportSampleCount: number | null
  laterReflectionIndex: number | null
  laterReflectionPeak: number | null
  candidateAbsoluteTimeMs: number | null
  earlySearchWindowStartSample: number
  earlySearchWindowEndSample: number
  topEarlyImpulsePeaks: Array<{ sample: number; amplitude: number; peakToNoiseDb: number | null }>
  strongestLaterReflectionDelayMs: number | null
  localSupportWindowStartSample: number | null
  localSupportWindowEndSample: number | null
  localSupportWindowMax: number | null
  localSupportSampleCount: number | null
}

export interface ImpulseResponsePoint {
  frequencyHz: number
  magnitudeDb: number
}

export interface ResponseWindowOptions {
  lfWindowMs?: number
  hfWindowMs?: number
  taperMs?: number
}

interface ImpulseResult {
  kind: 'ok'
  samples: Float32Array
  summary: ImpulseSummary
}

interface CaptureTooShortResult {
  kind: 'capture_too_short'
  availableSamples: number
  requiredSamples: number
}

export type DeconvolutionResult = ImpulseResult | CaptureTooShortResult

interface ReferenceFft {
  key: string
  real: Float32Array
  imaginary: Float32Array
  maximumPower: number
}

// A direct speaker-to-phone path should arrive well before this. Keeping the
// search bounded prevents any later circular/padded artifact from becoming
// the reported acoustic arrival even if a caller passes an untrimmed buffer.
const DIRECT_SEARCH_WINDOW_MS = 80
const DECAY_NOISE_MARGIN_DB = 6
const DECAY_ENDPOINT_TOLERANCE_DB = 1.5
const DECAY_MIN_POINTS = 8
const DECAY_MIN_R_SQUARED = 0.85
const DECAY_MAX_RESIDUAL_RMS_DB = 2
const RESAMPLER_PASSBAND_HZ = 20_000
const RESAMPLER_STOPBAND_HZ = 22_000
const RESAMPLER_PASSBAND_MAX_ERROR_DB = 0.1
const RESAMPLER_STOPBAND_MAX_ERROR_DB = -80
const RESAMPLER_MAX_CLOCK_DRIFT_PPM = 1_000
const RESAMPLER_DEFAULT_SAMPLE_RATE = 48_000
const RESAMPLER_TAP_COUNT = 127
const RESAMPLER_HALF_TAP_COUNT = Math.floor(RESAMPLER_TAP_COUNT / 2)
const RESAMPLER_PHASE_COUNT = 512
let cachedReferenceFft: ReferenceFft | null = null

interface ResamplerKernel {
  sampleRate: number
  coefficients: Float32Array
}

let cachedResamplerKernel: ResamplerKernel | null = null

function rms(samples: Float32Array, start = 0, end = samples.length): number {
  let sum = 0
  let count = 0
  for (let index = Math.max(0, start); index < Math.min(samples.length, end); index++) {
    sum += samples[index] * samples[index]
    count++
  }
  return count > 0 ? Math.sqrt(sum / count) : 0
}

function db(value: number, floor = -120): number {
  return value > 0 && Number.isFinite(value) ? Math.max(floor, 20 * Math.log10(value)) : floor
}

function dbRatio(numerator: number | null, denominator: number | null): number | null {
  if (!(numerator > 0) || !(denominator > 0)) return null
  return 10 * Math.log10(numerator / denominator)
}

interface RegressionFit {
  slope: number
  rSquared: number
  residualRmsDb: number
}

function regressionFit(points: Array<{ x: number; y: number }>): RegressionFit | null {
  if (points.length < 3) return null
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length
  let numerator = 0
  let denominator = 0
  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY)
    denominator += (point.x - meanX) ** 2
  }
  if (denominator <= 0) return null
  const slope = numerator / denominator
  let totalVariance = 0
  let residualSumSquares = 0
  for (const point of points) {
    const predicted = meanY + slope * (point.x - meanX)
    totalVariance += (point.y - meanY) ** 2
    residualSumSquares += (point.y - predicted) ** 2
  }
  return {
    slope,
    rSquared: totalVariance > 0 ? Math.max(0, 1 - residualSumSquares / totalVariance) : 0,
    residualRmsDb: Math.sqrt(residualSumSquares / points.length),
  }
}

export function decayTime(
  edcDb: Float64Array,
  sampleRate: number,
  fromDb: number,
  toDb: number,
  noiseFloorDb: number | null = null,
  noiseMarginDb = DECAY_NOISE_MARGIN_DB,
): number | null {
  if (!(sampleRate > 0) || !Number.isFinite(fromDb) || !Number.isFinite(toDb) || fromDb <= toDb) return null
  if (noiseFloorDb !== null && (!Number.isFinite(noiseFloorDb) || noiseFloorDb + noiseMarginDb > toDb)) return null

  const points: Array<{ x: number; y: number }> = []
  for (let index = 0; index < edcDb.length; index += Math.max(1, Math.round(sampleRate / 500))) {
    const value = edcDb[index]
    if (Number.isFinite(value) && value <= fromDb && value >= toDb) {
      points.push({ x: index / sampleRate, y: value })
    }
  }
  if (points.length < DECAY_MIN_POINTS) return null

  const highestPoint = Math.max(...points.map((point) => point.y))
  const lowestPoint = Math.min(...points.map((point) => point.y))
  if (highestPoint < fromDb - DECAY_ENDPOINT_TOLERANCE_DB) return null
  if (lowestPoint > toDb + DECAY_ENDPOINT_TOLERANCE_DB) return null

  const fit = regressionFit(points)
  if (fit === null || fit.slope >= -0.001) return null
  if (fit.rSquared < DECAY_MIN_R_SQUARED || fit.residualRmsDb > DECAY_MAX_RESIDUAL_RMS_DB) return null
  const durationMs = (-60 / fit.slope) * 1000
  return Number.isFinite(durationMs) && durationMs > 0 && durationMs <= 10_000 ? durationMs : null
}

function energyBetween(samples: Float32Array, start: number, end: number, noisePower = 0): number {
  let energy = 0
  const boundedStart = Math.max(0, start)
  const boundedEnd = Math.min(samples.length, end)
  for (let index = boundedStart; index < boundedEnd; index++) {
    energy += samples[index] * samples[index]
  }
  return Math.max(0, energy - Math.max(0, boundedEnd - boundedStart) * noisePower)
}

function reliableEnergyBetween(samples: Float32Array, start: number, end: number, noisePower: number): number | null {
  const boundedStart = Math.max(0, start)
  const boundedEnd = Math.min(samples.length, end)
  const expectedNoiseEnergy = Math.max(0, boundedEnd - boundedStart) * noisePower
  const correctedEnergy = energyBetween(samples, boundedStart, boundedEnd, noisePower)
  if (!(correctedEnergy > 0)) return null
  if (noisePower > 0 && correctedEnergy < expectedNoiseEnergy * 2) return null
  return correctedEnergy
}

function strongestLaterReflection(samples: Float32Array, start: number): {
  index: number | null
  peak: number
} {
  let index: number | null = null
  let peak = 0
  for (let cursor = Math.max(0, start); cursor < samples.length; cursor++) {
    const value = Math.abs(samples[cursor] ?? 0)
    if (value > peak) {
      peak = value
      index = cursor
    }
  }
  return { index, peak }
}

function topEarlyImpulsePeaks(
  samples: Float32Array,
  start: number,
  end: number,
  noiseRms: number,
): Array<{ sample: number; amplitude: number; peakToNoiseDb: number | null }> {
  const peaks: Array<{ sample: number; amplitude: number; peakToNoiseDb: number | null }> = []
  for (let index = Math.max(0, start); index < Math.min(samples.length, end); index++) {
    const amplitude = Math.abs(samples[index] ?? 0)
    const left = index > start ? Math.abs(samples[index - 1] ?? 0) : amplitude
    const right = index + 1 < end ? Math.abs(samples[index + 1] ?? 0) : amplitude
    if (amplitude === 0 || amplitude < left || amplitude < right) continue
    peaks.push({
      sample: index,
      amplitude,
      peakToNoiseDb: dbRatio(amplitude ** 2, noiseRms ** 2),
    })
  }
  return peaks
    .sort((left, right) => right.amplitude - left.amplitude || left.sample - right.sample)
    .slice(0, 16)
}

function referenceCacheKey(
  sweep: MeasurementSweep,
  sampleRate: number,
  fftLength: number,
): string {
  return [
    sweep.algorithm,
    sweep.sampleRate,
    sweep.startHz,
    sweep.endHz,
    sweep.durationMs,
    sweep.preRollMs,
    sweep.postRollMs,
    sweep.sweepLevelDbfs,
    sweep.markerLevelDbfs,
    sweep.fadeInMs,
    sweep.fadeOutMs,
    sampleRate,
    fftLength,
  ].join('|')
}

function normalizedSinc(value: number): number {
  return Math.abs(value) < 1e-12 ? 1 : Math.sin(Math.PI * value) / (Math.PI * value)
}

function modifiedBesselI0(value: number): number {
  let sum = 1
  let term = 1
  for (let order = 1; order < 30; order++) {
    term *= value * value / (4 * order * order)
    sum += term
    if (term < sum * 1e-14) break
  }
  return sum
}

function kaiserBeta(attenuationDb: number): number {
  if (attenuationDb > 50) return 0.1102 * (attenuationDb - 8.7)
  if (attenuationDb >= 21) return 0.5842 * (attenuationDb - 21) ** 0.4 + 0.07886 * (attenuationDb - 21)
  return 0
}

const resamplerPassbandRipple = 10 ** (RESAMPLER_PASSBAND_MAX_ERROR_DB / 20) - 1
const RESAMPLER_KAISER_BETA = kaiserBeta(Math.max(
  -20 * Math.log10(resamplerPassbandRipple),
  -RESAMPLER_STOPBAND_MAX_ERROR_DB,
))
const RESAMPLER_BESSEL_DENOMINATOR = modifiedBesselI0(RESAMPLER_KAISER_BETA)

function createResamplerKernel(sampleRate: number): Float32Array {
  const worstCaseSourceRate = sampleRate * (1 - RESAMPLER_MAX_CLOCK_DRIFT_PPM / 1_000_000)
  const passbandFraction = Math.min(0.499, RESAMPLER_PASSBAND_HZ / worstCaseSourceRate)
  const stopbandFraction = Math.min(0.4999, RESAMPLER_STOPBAND_HZ / worstCaseSourceRate)
  const cutoffFraction = Math.min(0.4995, Math.max(0.05, (passbandFraction + stopbandFraction) / 2))
  const kernels = new Float32Array(RESAMPLER_PHASE_COUNT * RESAMPLER_TAP_COUNT)
  for (let phaseIndex = 0; phaseIndex < RESAMPLER_PHASE_COUNT; phaseIndex++) {
    const fraction = phaseIndex / RESAMPLER_PHASE_COUNT
    const kernelOffset = phaseIndex * RESAMPLER_TAP_COUNT
    let sum = 0
    for (let tapIndex = 0; tapIndex < RESAMPLER_TAP_COUNT; tapIndex++) {
      const offset = tapIndex - RESAMPLER_HALF_TAP_COUNT
      const distance = offset - fraction
      const windowCoordinate = 2 * tapIndex / (RESAMPLER_TAP_COUNT - 1) - 1
      const kaiser = modifiedBesselI0(RESAMPLER_KAISER_BETA * Math.sqrt(Math.max(0, 1 - windowCoordinate * windowCoordinate))) / RESAMPLER_BESSEL_DENOMINATOR
      const coefficient = 2 * cutoffFraction * normalizedSinc(2 * cutoffFraction * distance) * kaiser
      kernels[kernelOffset + tapIndex] = coefficient
      sum += coefficient
    }
    if (sum !== 0) {
      for (let tapIndex = 0; tapIndex < RESAMPLER_TAP_COUNT; tapIndex++) {
        kernels[kernelOffset + tapIndex] /= sum
      }
    }
  }
  return kernels
}

function getResamplerKernel(sampleRate: number): Float32Array {
  const safeSampleRate = Number.isFinite(sampleRate) && sampleRate > 0
    ? sampleRate
    : RESAMPLER_DEFAULT_SAMPLE_RATE
  if (cachedResamplerKernel?.sampleRate === safeSampleRate) return cachedResamplerKernel.coefficients
  const coefficients = createResamplerKernel(safeSampleRate)
  cachedResamplerKernel = { sampleRate: safeSampleRate, coefficients }
  return coefficients
}

function resampleCapture(
  samples: Float32Array,
  startSample: number,
  captureLength: number,
  targetLength: number,
  clockRatio: number,
  sampleRate: number,
): Float32Array {
  const result = new Float32Array(targetLength)
  const captureStart = Math.min(samples.length, Math.max(0, Math.floor(startSample)))
  const boundedCaptureLength = Math.max(0, Math.floor(captureLength))
  const captureEnd = Math.min(samples.length, captureStart + boundedCaptureLength)
  const sourceLength = captureEnd - captureStart
  if (sourceLength <= 0) return result

  const safeClockRatio = Number.isFinite(clockRatio) && clockRatio > 0 ? clockRatio : 1
  if (safeClockRatio === 1) {
    for (let index = 0; index < targetLength; index++) {
      result[index] = samples[captureStart + Math.min(sourceLength - 1, index)] ?? 0
    }
    return result
  }

  const kernels = getResamplerKernel(sampleRate)
  for (let index = 0; index < targetLength; index++) {
    const sourcePosition = Math.min(sourceLength - 1, index * safeClockRatio)
    const lower = Math.floor(sourcePosition)
    const fraction = sourcePosition - lower
    let phase = Math.round(fraction * RESAMPLER_PHASE_COUNT)
    let base = lower
    if (phase === RESAMPLER_PHASE_COUNT) {
      phase = 0
      base++
    }

    const kernelOffset = phase * RESAMPLER_TAP_COUNT
    const firstSourceIndex = base - RESAMPLER_HALF_TAP_COUNT
    const firstAbsoluteIndex = captureStart + firstSourceIndex
    let value = 0
    if (firstSourceIndex >= 0 && firstSourceIndex + RESAMPLER_TAP_COUNT <= sourceLength && firstAbsoluteIndex >= 0 && firstAbsoluteIndex + RESAMPLER_TAP_COUNT <= samples.length) {
      for (let tapIndex = 0; tapIndex < RESAMPLER_TAP_COUNT; tapIndex++) {
        value += samples[firstAbsoluteIndex + tapIndex] * kernels[kernelOffset + tapIndex]
      }
    } else {
      for (let tapIndex = 0; tapIndex < RESAMPLER_TAP_COUNT; tapIndex++) {
        const sourceIndex = Math.max(
          captureStart,
          Math.min(captureEnd - 1, firstAbsoluteIndex + tapIndex),
        )
        value += samples[sourceIndex] * kernels[kernelOffset + tapIndex]
      }
    }
    result[index] = value
  }
  return result
}

export function resampleCaptureForTest(
  samples: Float32Array,
  clockRatio: number,
  sampleRate = RESAMPLER_DEFAULT_SAMPLE_RATE,
): Float32Array {
  return resampleCapture(samples, 0, samples.length, samples.length, clockRatio, sampleRate)
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const position = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))
  return sorted[position] ?? 0
}

function estimateTailNoiseRms(samples: Float32Array, start: number, end: number): number {
  const boundedStart = Math.max(0, Math.min(samples.length, start))
  const boundedEnd = Math.max(boundedStart, Math.min(samples.length, end))
  const length = boundedEnd - boundedStart
  if (length === 0) return 0

  const blockLength = Math.max(1, Math.floor(length / 8))
  const blockLevels: number[] = []
  for (let blockStart = boundedStart; blockStart < boundedEnd; blockStart += blockLength) {
    blockLevels.push(rms(samples, blockStart, Math.min(boundedEnd, blockStart + blockLength)))
  }
  return blockLevels.length >= 4 ? percentile(blockLevels, 0.75) : rms(samples, boundedStart, boundedEnd)
}

function getReferenceFft(
  sweep: MeasurementSweep,
  sampleRate: number,
  fftLength: number,
): ReferenceFft {
  const key = referenceCacheKey(sweep, sampleRate, fftLength)
  if (cachedReferenceFft?.key === key) return cachedReferenceFft

  const reference = generateSweepSignal(sweep, sampleRate)
  const real = new Float32Array(fftLength)
  const imaginary = new Float32Array(fftLength)
  for (let index = 0; index < reference.length; index++) real[index] = reference[index]
  fftInPlace(real, imaginary)
  let maximumPower = 0
  for (let index = 0; index < fftLength; index++) {
    maximumPower = Math.max(maximumPower, real[index] ** 2 + imaginary[index] ** 2)
  }
  cachedReferenceFft = { key, real, imaginary, maximumPower }
  return cachedReferenceFft
}

interface DirectArrivalSearchResult {
  index: number | null
  peakIndex: number | null
  noiseRms: number
  peak: number
  directPeak: number
  acceptanceThreshold: number
  rejectionReason: DirectArrivalRejectionReason | null
  supportWindowRms?: number
  supportWindowThreshold?: number
  supportSampleCount?: number
  laterReflectionIndex?: number | null
  laterReflectionPeak?: number | null
  candidateAbsoluteTimeMs: number | null
  earlySearchWindowStartSample: number
  earlySearchWindowEndSample: number
  topEarlyImpulsePeaks: Array<{ sample: number; amplitude: number; peakToNoiseDb: number | null }>
  strongestLaterReflectionDelayMs: number | null
  localSupportWindowStartSample: number | null
  localSupportWindowEndSample: number | null
  localSupportWindowMax: number | null
  localSupportSampleCount: number | null
}

export function findDirectArrival(samples: Float32Array, sampleRate: number, externalNoiseRms: number | null = null): DirectArrivalSearchResult {
  // The causal impulse starts at the trimmed active-sweep boundary. A short
  // tail must not become the noise estimate for the direct path at index zero.
  const noiseStart = samples.length > 8
    ? Math.max(
        Math.floor(samples.length * 0.75),
        samples.length - Math.round(sampleRate * 0.25),
      )
    : samples.length
  const tailNoiseRms = estimateTailNoiseRms(samples, noiseStart, samples.length)
  const noiseFloorRms = Number.isFinite(externalNoiseRms) && externalNoiseRms !== null
    ? Math.max(0, externalNoiseRms)
    : tailNoiseRms
  let peak = 0
  for (let index = 0; index < samples.length; index++) {
    const value = Math.abs(samples[index])
    if (value > peak) {
      peak = value
    }
  }
  const searchEnd = Math.min(samples.length, Math.max(1, Math.round(sampleRate * DIRECT_SEARCH_WINDOW_MS / 1000)))
  const earlySearchWindowStartSample = 0
  const earlySearchWindowEndSample = searchEnd
  const earlyPeaks = topEarlyImpulsePeaks(samples, earlySearchWindowStartSample, earlySearchWindowEndSample, noiseFloorRms)
  let directPeak = 0
  let directPeakIndex = -1
  for (let index = 0; index < searchEnd; index++) {
    const value = Math.abs(samples[index])
    if (value > directPeak) {
      directPeak = value
      directPeakIndex = index
    }
  }
  const peakGate = Math.max(noiseFloorRms * 6, 1e-7)
  if (directPeakIndex < 0) {
    return {
      index: null,
      peakIndex: null,
      noiseRms: noiseFloorRms,
      peak,
      directPeak,
      acceptanceThreshold: peakGate,
      rejectionReason: 'no_candidate',
      candidateAbsoluteTimeMs: null,
      earlySearchWindowStartSample,
      earlySearchWindowEndSample,
      topEarlyImpulsePeaks: earlyPeaks,
      strongestLaterReflectionDelayMs: null,
      localSupportWindowStartSample: null,
      localSupportWindowEndSample: null,
      localSupportWindowMax: null,
      localSupportSampleCount: null,
    }
  }
  if (directPeak <= peakGate) {
    const supportRadius = Math.max(1, Math.round(sampleRate * 0.0001))
    const supportStart = Math.max(0, directPeakIndex - supportRadius)
    const supportEnd = Math.min(searchEnd, directPeakIndex + supportRadius + 1)
    let supportEnergy = 0
    let supportMax = 0
    let supportSamples = 0
    for (let cursor = supportStart; cursor < supportEnd; cursor++) {
      if (cursor === directPeakIndex) continue
      const sample = Math.abs(samples[cursor] ?? 0)
      supportEnergy += sample * sample
      supportMax = Math.max(supportMax, sample)
      supportSamples++
    }
    const laterReflection = strongestLaterReflection(samples, directPeakIndex + supportRadius + 1)
    return {
      index: null,
      peakIndex: directPeakIndex,
      noiseRms: noiseFloorRms,
      peak,
      directPeak,
      acceptanceThreshold: peakGate,
      rejectionReason: 'peak_below_noise',
      candidateAbsoluteTimeMs: directPeakIndex * 1000 / sampleRate,
      earlySearchWindowStartSample,
      earlySearchWindowEndSample,
      topEarlyImpulsePeaks: earlyPeaks,
      strongestLaterReflectionDelayMs: laterReflection.index === null ? null : (laterReflection.index - directPeakIndex) * 1000 / sampleRate,
      localSupportWindowStartSample: supportStart,
      localSupportWindowEndSample: supportEnd,
      localSupportWindowMax: supportMax,
      localSupportSampleCount: supportSamples,
    }
  }

  const threshold = Math.max(directPeak * 0.03, noiseFloorRms * 8, 1e-7)
  const supportRadius = Math.max(1, Math.round(sampleRate * 0.0001))
  let rejectedCandidate: {
    index: number
    peak: number
    supportWindowRms: number
    supportWindowThreshold: number
    supportSampleCount: number
    supportWindowMax: number
  } | null = null
  for (let index = 0; index <= directPeakIndex; index++) {
    const value = Math.abs(samples[index])
    const left = index > 0 ? Math.abs(samples[index - 1]) : value
    const right = index + 1 < searchEnd ? Math.abs(samples[index + 1]) : value
    if (value < left || value < right) continue
    if (value < threshold) continue
    const supportStart = Math.max(0, index - supportRadius)
    const supportEnd = Math.min(searchEnd, index + supportRadius + 1)
    let supportEnergy = 0
    let supportSamples = 0
    let supportMax = 0
    for (let cursor = supportStart; cursor < supportEnd; cursor++) {
      if (cursor === index) continue
      const sample = samples[cursor] ?? 0
      supportEnergy += sample * sample
      supportMax = Math.max(supportMax, Math.abs(sample))
      supportSamples++
    }
    const supportRms = Math.sqrt(supportEnergy / Math.max(1, supportSamples))
    const supportThreshold = Math.max(noiseFloorRms * 1.5, threshold * 0.05)
    if (supportRms >= supportThreshold
      || (index === 0 && directPeak >= threshold)) {
      const laterReflection = strongestLaterReflection(samples, index + supportRadius + 1)
      return {
        index,
        peakIndex: directPeakIndex,
        noiseRms: noiseFloorRms,
        peak,
        directPeak,
        acceptanceThreshold: threshold,
        rejectionReason: null,
        supportWindowRms: supportRms,
        supportWindowThreshold: supportThreshold,
        supportSampleCount: supportSamples,
        laterReflectionIndex: laterReflection.index,
        laterReflectionPeak: laterReflection.peak,
        candidateAbsoluteTimeMs: index * 1000 / sampleRate,
        earlySearchWindowStartSample,
        earlySearchWindowEndSample,
        topEarlyImpulsePeaks: earlyPeaks,
        strongestLaterReflectionDelayMs: laterReflection.index === null ? null : (laterReflection.index - index) * 1000 / sampleRate,
        localSupportWindowStartSample: supportStart,
        localSupportWindowEndSample: supportEnd,
        localSupportWindowMax: supportMax,
        localSupportSampleCount: supportSamples,
      }
    }
    if (rejectedCandidate === null
      || value > rejectedCandidate.peak
      || (value === rejectedCandidate.peak && index < rejectedCandidate.index)) {
      rejectedCandidate = {
        index,
        peak: value,
        supportWindowRms: supportRms,
        supportWindowThreshold: supportThreshold,
        supportSampleCount: supportSamples,
        supportWindowMax: supportMax,
      }
    }
  }
  const rejectedLaterReflection = rejectedCandidate === null
    ? { index: null, peak: 0 }
    : strongestLaterReflection(samples, rejectedCandidate.index + supportRadius + 1)
  return {
    index: null,
    peakIndex: rejectedCandidate?.index ?? directPeakIndex,
    noiseRms: noiseFloorRms,
    peak,
    directPeak,
    acceptanceThreshold: threshold,
    supportWindowRms: rejectedCandidate?.supportWindowRms ?? null,
    supportWindowThreshold: rejectedCandidate?.supportWindowThreshold ?? null,
    supportSampleCount: rejectedCandidate?.supportSampleCount ?? null,
    laterReflectionIndex: rejectedLaterReflection.index,
    laterReflectionPeak: rejectedLaterReflection.peak,
    rejectionReason: 'candidate_not_sustained',
    candidateAbsoluteTimeMs: rejectedCandidate ? rejectedCandidate.index * 1000 / sampleRate : null,
    earlySearchWindowStartSample,
    earlySearchWindowEndSample,
    topEarlyImpulsePeaks: earlyPeaks,
    strongestLaterReflectionDelayMs: rejectedCandidate && rejectedLaterReflection.index !== null
      ? (rejectedLaterReflection.index - rejectedCandidate.index) * 1000 / sampleRate
      : null,
    localSupportWindowStartSample: rejectedCandidate ? Math.max(0, rejectedCandidate.index - supportRadius) : null,
    localSupportWindowEndSample: rejectedCandidate ? Math.min(searchEnd, rejectedCandidate.index + supportRadius + 1) : null,
    localSupportWindowMax: rejectedCandidate?.supportWindowMax ?? null,
    localSupportSampleCount: rejectedCandidate?.supportSampleCount ?? null,
  }
}

function directArrivalDiagnostics(arrival: ReturnType<typeof findDirectArrival>): DirectArrivalDiagnostics {
  return {
    directPeak: arrival.directPeak,
    noiseFloorRms: arrival.noiseRms,
    peakToNoiseDb: dbRatio(arrival.directPeak ** 2, arrival.noiseRms ** 2),
    acceptanceThreshold: arrival.acceptanceThreshold,
    candidateArrivalIndex: arrival.peakIndex,
    acceptedArrivalIndex: arrival.index,
    rejectionReason: arrival.rejectionReason,
    supportWindowRms: arrival.supportWindowRms ?? null,
    supportWindowThreshold: arrival.supportWindowThreshold ?? null,
    supportSampleCount: arrival.supportSampleCount ?? null,
    laterReflectionIndex: arrival.laterReflectionIndex ?? null,
    laterReflectionPeak: arrival.laterReflectionPeak ?? null,
    candidateAbsoluteTimeMs: arrival.candidateAbsoluteTimeMs,
    earlySearchWindowStartSample: arrival.earlySearchWindowStartSample,
    earlySearchWindowEndSample: arrival.earlySearchWindowEndSample,
    topEarlyImpulsePeaks: arrival.topEarlyImpulsePeaks,
    strongestLaterReflectionDelayMs: arrival.strongestLaterReflectionDelayMs,
    localSupportWindowStartSample: arrival.localSupportWindowStartSample,
    localSupportWindowEndSample: arrival.localSupportWindowEndSample,
    localSupportWindowMax: arrival.localSupportWindowMax,
    localSupportSampleCount: arrival.localSupportSampleCount,
  }
}

function findEarlyReflections(
  samples: Float32Array,
  directIndex: number,
  sampleRate: number,
  directPeak: number,
): EarlyReflection[] {
  const start = directIndex + Math.max(1, Math.round(sampleRate * 0.0025))
  const end = Math.min(samples.length, directIndex + Math.round(sampleRate * 0.08))
  const minimum = Math.max(directPeak * 0.08, 1e-7)
  const separation = Math.max(1, Math.round(sampleRate * 0.001))
  const candidates: Array<{ index: number; value: number }> = []
  for (let index = start + 1; index < end; index++) {
    const value = Math.abs(samples[index])
    const right = index + 1 < samples.length ? Math.abs(samples[index + 1]) : value
    if (value < minimum || value < Math.abs(samples[index - 1]) || value < right) continue
    candidates.push({ index, value })
  }
  candidates.sort((left, right) => right.value - left.value)
  const selected: Array<{ index: number; value: number }> = []
  for (const candidate of candidates) {
    if (selected.some((other) => Math.abs(other.index - candidate.index) < separation)) continue
    selected.push(candidate)
    if (selected.length >= 6) break
  }
  return selected
    .sort((left, right) => left.index - right.index)
    .map((reflection) => ({
      delayMs: (reflection.index - directIndex) * 1000 / sampleRate,
      levelDbRelativeToDirect: dbRatio(reflection.value ** 2, directPeak ** 2) ?? -120,
    }))
}

interface DecayCurve {
  valuesDb: Float64Array
  initialEnergy: number
  noiseEnergy: number
}

function buildDecayCurve(samples: Float32Array, directIndex: number, noisePower: number): DecayCurve {
  const energy = new Float64Array(samples.length - directIndex)
  let total = 0
  for (let index = samples.length - 1; index >= directIndex; index--) {
    total += samples[index] * samples[index]
    const remainingSamples = samples.length - index
    energy[index - directIndex] = Math.max(0, total - remainingSamples * noisePower)
  }
  const initial = energy[0] || 1
  for (let index = 0; index < energy.length; index++) {
    energy[index] = db(Math.sqrt(Math.max(0, energy[index] / initial)), -120)
  }
  return {
    valuesDb: energy,
    initialEnergy: initial,
    noiseEnergy: (samples.length - directIndex) * noisePower,
  }
}

export function summarizeImpulse(samples: Float32Array, sampleRate: number, externalNoiseRms: number | null = null): ImpulseSummary {
  const arrival = findDirectArrival(samples, sampleRate, externalNoiseRms)
  if (arrival.index === null) {
    return {
      room: {
        directArrivalMs: null,
        earlyReflections: [],
        directToLateDb: null,
        c50Db: null,
        c80Db: null,
        edtMs: null,
        t20Ms: null,
        t30Ms: null,
        decayConfidence: 'low',
      },
      impulseLengthSamples: samples.length,
      noiseFloorRms: arrival.noiseRms,
      peak: arrival.peak,
      directArrival: directArrivalDiagnostics(arrival),
    }
  }

  const directIndex = arrival.index
  const directPeak = Math.max(Math.abs(samples[arrival.peakIndex ?? directIndex]), 1e-7)
  const earlyEnd = directIndex + Math.round(sampleRate * 0.05)
  const clarityEnd = directIndex + Math.round(sampleRate * 0.08)
  const directEnd = directIndex + Math.max(1, Math.round(sampleRate * 0.0025))
  const noiseRms = arrival.noiseRms
  const noisePower = noiseRms ** 2
  const directEnergy = energyBetween(samples, directIndex, directEnd, noisePower)
  const earlyEnergy = energyBetween(samples, directIndex, earlyEnd, noisePower)
  const c80Energy = energyBetween(samples, directIndex, clarityEnd, noisePower)
  const lateEnergy = reliableEnergyBetween(samples, earlyEnd, samples.length, noisePower)
  const lateClarityEnergy = reliableEnergyBetween(samples, clarityEnd, samples.length, noisePower)
  const decay = buildDecayCurve(samples, directIndex, noisePower)
  const noiseFloorDb = dbRatio(decay.noiseEnergy, decay.initialEnergy) ?? -120
  const edtMs = decayTime(decay.valuesDb, sampleRate, 0, -10, noiseFloorDb, 3)
  const t20Ms = decayTime(decay.valuesDb, sampleRate, -5, -25, noiseFloorDb, 3)
  const t30Ms = decayTime(decay.valuesDb, sampleRate, -5, -35, noiseFloorDb, DECAY_NOISE_MARGIN_DB)
  const decayConfidence = t30Ms !== null
    ? 'high'
    : t20Ms !== null
      ? 'medium'
      : 'low'

  return {
    room: {
      directArrivalMs: directIndex * 1000 / sampleRate,
      earlyReflections: findEarlyReflections(samples, directIndex, sampleRate, directPeak),
      directToLateDb: dbRatio(directEnergy, lateEnergy),
      c50Db: dbRatio(earlyEnergy, lateEnergy),
      c80Db: dbRatio(c80Energy, lateClarityEnergy),
      edtMs,
      t20Ms,
      t30Ms,
      decayConfidence,
    },
    impulseLengthSamples: samples.length,
    noiseFloorRms: noiseRms,
    peak: arrival.peak,
    directArrival: directArrivalDiagnostics(arrival),
  }
}

/** Diagnostic-path deconvolution; production captures are analyzed on the TV. */
export function deconvolveSweep(
  samples: Float32Array,
  sampleRate: number,
  sweep: MeasurementSweep,
  startSample: number,
  clockRatio = 1,
  captureNoiseRms: number | null = null,
): DeconvolutionResult {
  const parts = sweepSampleParts(sweep, sampleRate)
  const referenceLength = parts.sweepSamples
  // Detection returns the beginning of the TV's complete sweep envelope. The
  // pre-roll is silence, so exclude it from the transfer calculation. This
  // keeps the FFT bounded when the recorder captured a long lead-in.
  const captureStart = Math.min(samples.length, Math.max(0, startSample))
  const available = Math.max(0, samples.length - captureStart)
  const safeClockRatio = Number.isFinite(clockRatio) && clockRatio > 0 ? clockRatio : 1
  const requiredCaptureSamples = Math.ceil((referenceLength + parts.postRollSamples) * safeClockRatio)
  if (available < requiredCaptureSamples) {
    return {
      kind: 'capture_too_short',
      availableSamples: available,
      requiredSamples: requiredCaptureSamples,
    }
  }

  // Only the active sweep and the intentionally captured post-roll belong in
  // the transfer estimate. The causal IR therefore ends at post-roll + 1.
  const nominalCaptureLength = referenceLength + parts.postRollSamples
  const targetCaptureLength = Math.min(
    nominalCaptureLength,
    Math.max(referenceLength, Math.floor(available / safeClockRatio)),
  )
  const captureLength = Math.min(available, Math.ceil(targetCaptureLength * safeClockRatio))
  const causalLength = Math.min(
    targetCaptureLength - referenceLength + 1,
    parts.postRollSamples + 1,
  )
  // Zero padding prevents the late room response from wrapping around the
  // start of the recovered causal impulse during frequency-domain division.
  const fftLength = nextPowerOfTwo(Math.max(1, referenceLength + targetCaptureLength - 1))
  const referenceFft = getReferenceFft(sweep, sampleRate, fftLength)
  const captureReal = new Float32Array(fftLength)
  const captureImaginary = new Float32Array(fftLength)
  const warpedCapture = resampleCapture(samples, captureStart, captureLength, targetCaptureLength, safeClockRatio, sampleRate)
  for (let index = 0; index < warpedCapture.length; index++) captureReal[index] = warpedCapture[index]
  fftInPlace(captureReal, captureImaginary)
  const regularization = Math.max(referenceFft.maximumPower * 1e-7, 1e-12)
  let inverseFilterPower = 0
  for (let index = 0; index < fftLength; index++) {
    const xReal = referenceFft.real[index]
    const xImaginary = referenceFft.imaginary[index]
    const denominator = xReal * xReal + xImaginary * xImaginary + regularization
    const yReal = captureReal[index]
    const yImaginary = captureImaginary[index]
    inverseFilterPower += (xReal * xReal + xImaginary * xImaginary) / denominator ** 2
    captureReal[index] = (yReal * xReal + yImaginary * xImaginary) / denominator
    captureImaginary[index] = (yImaginary * xReal - yReal * xImaginary) / denominator
  }
  fftInPlace(captureReal, captureImaginary, true)
  const impulse = new Float32Array(causalLength)
  for (let index = 0; index < impulse.length; index++) impulse[index] = captureReal[index]
  const deconvolvedNoiseRms = Number.isFinite(captureNoiseRms) && captureNoiseRms !== null
    ? captureNoiseRms * Math.sqrt(inverseFilterPower / fftLength)
    : null
  return { kind: 'ok', samples: impulse, summary: summarizeImpulse(impulse, sampleRate, deconvolvedNoiseRms) }
}

/**
 * Converts the recovered impulse into a response for room correction. The
 * gate keeps the direct sound and early, repeatable reflections while fading
 * out the late field that is not safely correctable by magnitude EQ.
 */
export function windowedImpulseResponse(
  impulse: Float32Array,
  sampleRate: number,
  startHz: number,
  endHz: number,
  pointCount = 48,
  noiseRms: number | null = null,
  options: ResponseWindowOptions = {},
): ImpulseResponsePoint[] {
  if (impulse.length === 0 || sampleRate <= 0 || pointCount < 1) return []
  const arrival = findDirectArrival(impulse, sampleRate, noiseRms)
  if (arrival.index === null) return []
  const peakIndex = arrival.index

  const fftLength = nextPowerOfTwo(Math.max(impulse.length, 256, pointCount * 4))
  const windowedSpectrum = (gateMs: number, taperMs: number): { real: Float32Array; imaginary: Float32Array } => {
    const real = new Float32Array(fftLength)
    const imaginary = new Float32Array(fftLength)
    const preSamples = Math.max(1, Math.round(sampleRate * 0.001))
    const gateSamples = Math.max(preSamples + 1, Math.round(sampleRate * gateMs / 1000))
    const taperSamples = Math.max(1, Math.round(sampleRate * taperMs / 1000))
    const gateEnd = peakIndex + gateSamples
    const taperEnd = gateEnd + taperSamples
    for (let index = Math.max(0, peakIndex - preSamples); index < Math.min(impulse.length, taperEnd); index++) {
      const relative = index - peakIndex
      let weight = 0
      if (relative < 0) {
        weight = (relative + preSamples) / preSamples
      } else if (relative <= gateSamples) {
        weight = 1
      } else {
        weight = 0.5 * (1 + Math.cos(Math.PI * (relative - gateSamples) / taperSamples))
      }
      real[index] = impulse[index] * Math.max(0, Math.min(1, weight))
    }
    fftInPlace(real, imaginary)
    return { real, imaginary }
  }

  // LF needs the long window for usable modal resolution. The shorter window
  // prevents late, position-dependent field energy from becoming HF EQ.
  const lfWindowMs = Number.isFinite(options.lfWindowMs) && (options.lfWindowMs ?? 0) > 0 ? options.lfWindowMs ?? 250 : 250
  const hfWindowMs = Number.isFinite(options.hfWindowMs) && (options.hfWindowMs ?? 0) > 0 ? options.hfWindowMs ?? 80 : 80
  const taperMs = Number.isFinite(options.taperMs) && (options.taperMs ?? 0) > 0 ? options.taperMs ?? 40 : 40
  const longWindow = windowedSpectrum(lfWindowMs, taperMs)
  const shortWindow = windowedSpectrum(hfWindowMs, taperMs)

  const lowHz = Math.max(10, startHz)
  const highHz = Math.min(endHz, sampleRate / 2 - sampleRate / fftLength)
  if (!(highHz > lowHz)) return []
  const points: ImpulseResponsePoint[] = []
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    const progress = pointCount === 1 ? 0 : pointIndex / (pointCount - 1)
    const frequencyHz = lowHz * (highHz / lowHz) ** progress
    const centerBin = Math.max(1, Math.round(frequencyHz * fftLength / sampleRate))
    const binRadius = Math.max(2, Math.round(centerBin * 0.01))
    let totalDb = 0
    let count = 0
    for (
      let bin = Math.max(1, centerBin - binRadius);
      bin <= Math.min(fftLength / 2 - 1, centerBin + binRadius);
      bin++
    ) {
      const longMagnitude = Math.hypot(longWindow.real[bin], longWindow.imaginary[bin])
      const shortMagnitude = Math.hypot(shortWindow.real[bin], shortWindow.imaginary[bin])
      const transition = frequencyHz <= 200
        ? 0
        : frequencyHz >= 1_000
          ? 1
          : (Math.log(frequencyHz / 200) / Math.log(1_000 / 200))
      const blend = transition * transition * (3 - 2 * transition)
      const longDb = longMagnitude > 0 ? 20 * Math.log10(longMagnitude) : -120
      const shortDb = shortMagnitude > 0 ? 20 * Math.log10(shortMagnitude) : -120
      const magnitude = 10 ** ((longDb * (1 - blend) + shortDb * blend) / 20)
      if (magnitude > 0 && Number.isFinite(magnitude)) {
        totalDb += 20 * Math.log10(magnitude)
        count++
      }
    }
    points.push({ frequencyHz, magnitudeDb: count > 0 ? totalDb / count : -120 })
  }
  return points
}
