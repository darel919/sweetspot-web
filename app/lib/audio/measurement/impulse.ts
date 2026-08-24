import type { MeasurementSweep } from '#shared/types/protocol'
import { generateSweepReference } from '../sweep-reference'
import { fftInPlace, nextPowerOfTwo } from './fft'

export interface EarlyReflection {
  delayMs: number
  levelDbRelativeToDirect: number
}

export interface RoomMetrics {
  directArrivalMs: number | null
  earlyReflections: EarlyReflection[]
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
}

export interface ImpulseResponsePoint {
  frequencyHz: number
  magnitudeDb: number
}

interface ImpulseResult {
  samples: Float32Array
  summary: ImpulseSummary
}

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

function dbRatio(numerator: number, denominator: number): number | null {
  if (!(numerator > 0) || !(denominator > 0)) return null
  return 10 * Math.log10(numerator / denominator)
}

function regressionSlope(points: Array<{ x: number; y: number }>): number | null {
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
  return numerator / denominator
}

function decayTime(edcDb: Float64Array, sampleRate: number, fromDb: number, toDb: number): number | null {
  const points: Array<{ x: number; y: number }> = []
  for (let index = 0; index < edcDb.length; index += Math.max(1, Math.round(sampleRate / 200))) {
    const value = edcDb[index]
    if (value <= fromDb && value >= toDb) {
      points.push({ x: index / sampleRate, y: value })
    }
  }
  const slope = regressionSlope(points)
  if (slope === null || slope >= -0.001) return null
  const valueRange = Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y))
  if (valueRange < Math.abs(toDb - fromDb) * 0.5) return null
  const durationMs = ((toDb - fromDb) / slope) * 1000
  return Number.isFinite(durationMs) && durationMs > 0 && durationMs <= 10_000 ? durationMs : null
}

function energyBetween(samples: Float32Array, start: number, end: number): number {
  let energy = 0
  for (let index = Math.max(0, start); index < Math.min(samples.length, end); index++) {
    energy += samples[index] * samples[index]
  }
  return energy
}

function findDirectArrival(samples: Float32Array, sampleRate: number): {
  index: number | null
  peakIndex: number | null
  noiseRms: number
  peak: number
} {
  // The deconvolved impulse starts at the trimmed sweep boundary, so its
  // beginning contains the direct sound rather than a quiet pre-roll. Use the
  // far tail for the noise estimate instead of contaminating it with the
  // direct arrival.
  const noiseStart = Math.min(
    Math.max(0, Math.round(samples.length * 0.75)),
    Math.max(0, samples.length - Math.round(sampleRate * 0.25)),
  )
  const noiseFloorRms = rms(samples, noiseStart, samples.length)
  let peak = 0
  let peakIndex = -1
  for (let index = 0; index < samples.length; index++) {
    const value = Math.abs(samples[index])
    if (value > peak) {
      peak = value
      peakIndex = index
    }
  }
  if (peakIndex < 0 || peak <= Math.max(noiseFloorRms * 6, 1e-7)) {
    return { index: null, peakIndex: null, noiseRms: noiseFloorRms, peak }
  }

  const threshold = Math.max(peak * 0.08, noiseFloorRms * 8, 1e-7)
  const searchStart = Math.max(0, peakIndex - Math.round(sampleRate * 0.08))
  const sustain = Math.max(2, Math.round(sampleRate * 0.001))
  for (let index = searchStart; index <= peakIndex; index++) {
    if (Math.abs(samples[index]) < threshold) continue
    let sustained = true
    for (let cursor = index + 1; cursor < Math.min(samples.length, index + sustain); cursor++) {
      if (Math.abs(samples[cursor]) < threshold * 0.35) {
        sustained = false
        break
      }
    }
    if (sustained) return { index, peakIndex, noiseRms: noiseFloorRms, peak }
  }
  return { index: peakIndex, peakIndex, noiseRms: noiseFloorRms, peak }
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
  for (let index = start + 1; index < end - 1; index++) {
    const value = Math.abs(samples[index])
    if (value < minimum || value < Math.abs(samples[index - 1]) || value < Math.abs(samples[index + 1])) continue
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

function buildDecayCurve(samples: Float32Array, directIndex: number): Float64Array {
  const energy = new Float64Array(samples.length - directIndex)
  let total = 0
  for (let index = samples.length - 1; index >= directIndex; index--) {
    total += samples[index] * samples[index]
    energy[index - directIndex] = total
  }
  const initial = energy[0] || 1
  for (let index = 0; index < energy.length; index++) {
    energy[index] = db(Math.sqrt(Math.max(0, energy[index] / initial)), -120)
  }
  return energy
}

function summarizeImpulse(samples: Float32Array, sampleRate: number): ImpulseSummary {
  const arrival = findDirectArrival(samples, sampleRate)
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
    }
  }

  const directIndex = arrival.index
  const directPeak = Math.max(Math.abs(samples[arrival.peakIndex ?? directIndex]), 1e-7)
  const earlyEnd = directIndex + Math.round(sampleRate * 0.05)
  const clarityEnd = directIndex + Math.round(sampleRate * 0.08)
  const directEnd = directIndex + Math.max(1, Math.round(sampleRate * 0.0025))
  const directEnergy = energyBetween(samples, directIndex, directEnd)
  const earlyEnergy = energyBetween(samples, directIndex, earlyEnd)
  const c80Energy = energyBetween(samples, directIndex, clarityEnd)
  const lateEnergy = energyBetween(samples, earlyEnd, samples.length)
  const edc = buildDecayCurve(samples, directIndex)
  const snrDb = dbRatio(directPeak ** 2, arrival.noiseRms ** 2) ?? -120
  const decayConfidence = snrDb >= 30 && decayTime(edc, sampleRate, -5, -25) !== null
    ? 'high'
    : snrDb >= 18 && decayTime(edc, sampleRate, -5, -20) !== null
      ? 'medium'
      : 'low'

  return {
    room: {
      directArrivalMs: directIndex * 1000 / sampleRate,
      earlyReflections: findEarlyReflections(samples, directIndex, sampleRate, directPeak),
      directToLateDb: dbRatio(directEnergy, lateEnergy),
      c50Db: dbRatio(earlyEnergy, lateEnergy),
      c80Db: dbRatio(c80Energy, energyBetween(samples, clarityEnd, samples.length)),
      edtMs: decayTime(edc, sampleRate, 0, -10),
      t20Ms: decayTime(edc, sampleRate, -5, -25),
      t30Ms: decayTime(edc, sampleRate, -5, -35),
      decayConfidence,
    },
    impulseLengthSamples: samples.length,
    noiseFloorRms: arrival.noiseRms,
    peak: arrival.peak,
  }
}

/**
 * Regularized transfer deconvolution. The returned impulse is intentionally
 * kept browser-local; callers should retain only the compact summary.
 */
export function deconvolveSweep(
  samples: Float32Array,
  sampleRate: number,
  sweep: MeasurementSweep,
  startSample: number,
): ImpulseResult {
  const reference = generateSweepReference(sweep, sampleRate)
  const available = Math.max(0, samples.length - startSample)
  const maximumTailSamples = Math.round(sampleRate * 2)
  const captureLength = Math.min(available, reference.length + maximumTailSamples)
  // Zero padding prevents the late room response from wrapping around the
  // start of the recovered impulse during frequency-domain division.
  const fftLength = nextPowerOfTwo(Math.max(1, reference.length + captureLength - 1))
  const referenceReal = new Float64Array(fftLength)
  const captureReal = new Float64Array(fftLength)
  const referenceImaginary = new Float64Array(fftLength)
  const captureImaginary = new Float64Array(fftLength)
  for (let index = 0; index < reference.length; index++) {
    referenceReal[index] = reference[index]
  }
  for (let index = 0; index < captureLength; index++) captureReal[index] = samples[startSample + index]
  fftInPlace(referenceReal, referenceImaginary)
  fftInPlace(captureReal, captureImaginary)
  let maximumReferencePower = 0
  for (let index = 0; index < fftLength; index++) {
    maximumReferencePower = Math.max(
      maximumReferencePower,
      referenceReal[index] ** 2 + referenceImaginary[index] ** 2,
    )
  }
  const regularization = Math.max(maximumReferencePower * 1e-7, 1e-12)
  for (let index = 0; index < fftLength; index++) {
    const xReal = referenceReal[index]
    const xImaginary = referenceImaginary[index]
    const denominator = xReal * xReal + xImaginary * xImaginary + regularization
    const yReal = captureReal[index]
    const yImaginary = captureImaginary[index]
    referenceReal[index] = (yReal * xReal + yImaginary * xImaginary) / denominator
    referenceImaginary[index] = (yImaginary * xReal - yReal * xImaginary) / denominator
  }
  fftInPlace(referenceReal, referenceImaginary, true)
  const impulse = new Float32Array(referenceReal.length)
  for (let index = 0; index < impulse.length; index++) impulse[index] = referenceReal[index]
  return { samples: impulse, summary: summarizeImpulse(impulse, sampleRate) }
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
): ImpulseResponsePoint[] {
  if (impulse.length === 0 || sampleRate <= 0 || pointCount < 1) return []
  let peakIndex = 0
  let peak = 0
  for (let index = 0; index < impulse.length; index++) {
    const value = Math.abs(impulse[index])
    if (value > peak) {
      peak = value
      peakIndex = index
    }
  }
  if (!(peak > 0)) return []

  const fftLength = nextPowerOfTwo(impulse.length)
  const real = new Float64Array(fftLength)
  const imaginary = new Float64Array(fftLength)
  const preSamples = Math.max(1, Math.round(sampleRate * 0.001))
  const gateSamples = Math.max(preSamples + 1, Math.round(sampleRate * 0.25))
  const taperSamples = Math.max(1, Math.round(sampleRate * 0.04))
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
      const magnitude = Math.hypot(real[bin], imaginary[bin])
      if (magnitude > 0 && Number.isFinite(magnitude)) {
        totalDb += 20 * Math.log10(magnitude)
        count++
      }
    }
    points.push({ frequencyHz, magnitudeDb: count > 0 ? totalDb / count : -120 })
  }
  return points
}
