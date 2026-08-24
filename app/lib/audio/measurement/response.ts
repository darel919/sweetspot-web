import type { MeasurementSweep } from '#shared/types/protocol'
import { generateSweepReference, sweepSampleParts } from '../sweep-reference'
import {
  micCompensationDbAtHz,
  summarizeMicCalibrationProfile,
} from '../mics/profile'
import type { MicCalibrationProfile, MicCalibrationSummary } from '../mics/types'

export interface ResponsePoint {
  frequencyHz: number
  magnitudeDb: number
}

export interface SweepDetection {
  found: boolean
  startSample: number | null
  offsetMs: number | null
  confidence: number
}

export type MeasurementAnalysisStatus = 'ok' | 'signal_too_low' | 'sweep_not_found' | 'capture_clipped'

export interface MeasurementAnalysisDiagnostics {
  detected: boolean
  detectionOffsetMs: number | null
  detectionConfidence: number
  signalRms: number
  signalPeak: number
  clipped: boolean
  clippedSamples: number
  sampleCount: number
  frequencyPoints: number
}

export interface MeasurementAnalysis {
  status: MeasurementAnalysisStatus
  rawPoints: ResponsePoint[]
  points: ResponsePoint[]
  micProfile: MicCalibrationSummary
  diagnostics: MeasurementAnalysisDiagnostics
}

function nextPowerOfTwo(value: number): number {
  let result = 1
  while (result < value) result *= 2
  return result
}

function calculateSignalStats(samples: Float32Array): {
  rms: number
  peak: number
  clippedSamples: number
} {
  let sumSquares = 0
  let peak = 0
  let clippedSamples = 0
  for (const sample of samples) {
    const absolute = Math.abs(sample)
    sumSquares += sample * sample
    peak = Math.max(peak, absolute)
    if (absolute >= 0.999) clippedSamples++
  }
  return {
    rms: samples.length > 0 ? Math.sqrt(sumSquares / samples.length) : 0,
    peak,
    clippedSamples,
  }
}

function blockRms(samples: Float32Array, start: number, length: number): number {
  let sumSquares = 0
  const end = Math.min(samples.length, start + length)
  for (let index = start; index < end; index++) sumSquares += samples[index] * samples[index]
  const count = end - start
  return count > 0 ? Math.sqrt(sumSquares / count) : 0
}

export function detectSweepStart(
  samples: Float32Array,
  sweep: MeasurementSweep,
  sampleRate: number,
): SweepDetection {
  if (samples.length === 0 || sampleRate <= 0) {
    return { found: false, startSample: null, offsetMs: null, confidence: 0 }
  }
  const blockSize = Math.max(128, Math.round(sampleRate * 0.01))
  const blocks = Math.ceil(samples.length / blockSize)
  const levels = new Float64Array(blocks)
  let maximum = 0
  for (let index = 0; index < blocks; index++) {
    levels[index] = blockRms(samples, index * blockSize, blockSize)
    maximum = Math.max(maximum, levels[index])
  }
  if (maximum < 0.0001) return { found: false, startSample: null, offsetMs: null, confidence: 0 }

  const baselineBlocks = Math.min(blocks, 12)
  let baseline = 0
  for (let index = 0; index < baselineBlocks; index++) baseline += levels[index]
  baseline = baselineBlocks > 0 ? baseline / baselineBlocks : 0
  const threshold = Math.max(0.0001, baseline * 2.5, maximum * 0.08)
  let activeBlock = -1
  for (let index = 0; index < blocks - 1; index++) {
    if (levels[index] >= threshold && levels[index + 1] >= threshold) {
      activeBlock = index
      break
    }
  }
  if (activeBlock < 0) {
    activeBlock = levels.findIndex((level) => level >= threshold)
  }
  if (activeBlock < 0) return { found: false, startSample: null, offsetMs: null, confidence: 0 }

  const preRollSamples = sweepSampleParts(sweep, sampleRate).preRollSamples
  const startSample = Math.max(0, activeBlock * blockSize - preRollSamples)
  const confidence = Math.min(1, Math.max(0, (levels[activeBlock] - baseline) / Math.max(maximum - baseline, 0.0001)))
  return {
    found: true,
    startSample,
    offsetMs: startSample * 1000 / sampleRate,
    confidence,
  }
}

function fft(real: Float64Array, imaginary: Float64Array): void {
  const length = real.length
  for (let index = 1, reverse = 0; index < length; index++) {
    let bit = length >> 1
    for (; reverse & bit; bit >>= 1) reverse ^= bit
    reverse ^= bit
    if (index < reverse) {
      const realValue = real[index]
      real[index] = real[reverse]
      real[reverse] = realValue
      const imaginaryValue = imaginary[index]
      imaginary[index] = imaginary[reverse]
      imaginary[reverse] = imaginaryValue
    }
  }

  for (let width = 2; width <= length; width *= 2) {
    const angle = -2 * Math.PI / width
    const sine = Math.sin(angle)
    const cosine = Math.cos(angle)
    for (let start = 0; start < length; start += width) {
      let currentCosine = 1
      let currentSine = 0
      const half = width >> 1
      for (let offset = 0; offset < half; offset++) {
        const left = start + offset
        const right = left + half
        const rightReal = real[right] * currentCosine - imaginary[right] * currentSine
        const rightImaginary = real[right] * currentSine + imaginary[right] * currentCosine
        real[right] = real[left] - rightReal
        imaginary[right] = imaginary[left] - rightImaginary
        real[left] += rightReal
        imaginary[left] += rightImaginary
        const nextCosine = currentCosine * cosine - currentSine * sine
        currentSine = currentCosine * sine + currentSine * cosine
        currentCosine = nextCosine
      }
    }
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function normalizePoints(points: ResponsePoint[]): ResponsePoint[] {
  const center = median(points.map((point) => point.magnitudeDb))
  return points.map((point) => ({ ...point, magnitudeDb: point.magnitudeDb - center }))
}

export function smoothResponsePoints(points: ResponsePoint[]): ResponsePoint[] {
  if (points.length < 3) return points.map((point) => ({ ...point }))
  return points.map((point, index) => {
    const start = Math.max(0, index - 1)
    const end = Math.min(points.length - 1, index + 1)
    let total = 0
    let count = 0
    for (let cursor = start; cursor <= end; cursor++) {
      total += points[cursor].magnitudeDb
      count++
    }
    return { ...point, magnitudeDb: total / count }
  })
}

function estimateResponse(
  samples: Float32Array,
  sampleRate: number,
  sweep: MeasurementSweep,
  startSample: number,
): ResponsePoint[] {
  const reference = generateSweepReference(sweep, sampleRate)
  const fftLength = nextPowerOfTwo(reference.length)
  const referenceReal = new Float64Array(fftLength)
  const captureReal = new Float64Array(fftLength)
  const referenceImaginary = new Float64Array(fftLength)
  const captureImaginary = new Float64Array(fftLength)
  const windowDenominator = Math.max(1, reference.length - 1)
  let maximumReferencePower = 0

  for (let index = 0; index < reference.length; index++) {
    const window = 0.5 * (1 - Math.cos(2 * Math.PI * index / windowDenominator))
    referenceReal[index] = reference[index] * window
    const captureIndex = startSample + index
    captureReal[index] = (captureIndex < samples.length ? samples[captureIndex] : 0) * window
  }
  fft(referenceReal, referenceImaginary)
  fft(captureReal, captureImaginary)
  for (let index = 1; index < fftLength / 2; index++) {
    maximumReferencePower = Math.max(
      maximumReferencePower,
      referenceReal[index] ** 2 + referenceImaginary[index] ** 2,
    )
  }
  const regularization = Math.max(maximumReferencePower * 1e-6, 1e-12)
  const lowHz = Math.max(10, sweep.startHz)
  const highHz = Math.min(sweep.endHz, sampleRate / 2 - sampleRate / fftLength)
  const pointCount = 48
  const points: ResponsePoint[] = []

  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    const progress = pointCount === 1 ? 0 : pointIndex / (pointCount - 1)
    const frequencyHz = lowHz * (highHz / lowHz) ** progress
    const centerBin = Math.max(1, Math.round(frequencyHz * fftLength / sampleRate))
    const binRadius = Math.max(1, Math.round(centerBin * 0.015))
    let sum = 0
    let count = 0
    for (let bin = Math.max(1, centerBin - binRadius); bin <= Math.min(fftLength / 2 - 1, centerBin + binRadius); bin++) {
      const referencePower = referenceReal[bin] ** 2 + referenceImaginary[bin] ** 2
      const transferReal = captureReal[bin] * referenceReal[bin] + captureImaginary[bin] * referenceImaginary[bin]
      const transferImaginary = captureImaginary[bin] * referenceReal[bin] - captureReal[bin] * referenceImaginary[bin]
      const magnitude = Math.sqrt(transferReal ** 2 + transferImaginary ** 2) / (referencePower + regularization)
      if (Number.isFinite(magnitude) && magnitude > 0) {
        sum += 20 * Math.log10(magnitude)
        count++
      }
    }
    points.push({ frequencyHz, magnitudeDb: count > 0 ? sum / count : 0 })
  }
  return normalizePoints(points)
}

export function analyzeMeasurement(
  samples: Float32Array,
  sampleRate: number,
  sweep: MeasurementSweep,
  micProfile: MicCalibrationProfile,
): MeasurementAnalysis {
  const signal = calculateSignalStats(samples)
  const detection = detectSweepStart(samples, sweep, sampleRate)
  const baseDiagnostics: MeasurementAnalysisDiagnostics = {
    detected: detection.found,
    detectionOffsetMs: detection.offsetMs,
    detectionConfidence: detection.confidence,
    signalRms: signal.rms,
    signalPeak: signal.peak,
    clipped: signal.clippedSamples > 0,
    clippedSamples: signal.clippedSamples,
    sampleCount: samples.length,
    frequencyPoints: 0,
  }

  if (signal.rms < 0.0001) {
    return {
      status: 'signal_too_low',
      rawPoints: [],
      points: [],
      micProfile: summarizeMicCalibrationProfile(micProfile),
      diagnostics: baseDiagnostics,
    }
  }
  if (!detection.found || detection.startSample === null) {
    return {
      status: 'sweep_not_found',
      rawPoints: [],
      points: [],
      micProfile: summarizeMicCalibrationProfile(micProfile),
      diagnostics: baseDiagnostics,
    }
  }

  const rawPoints = estimateResponse(samples, sampleRate, sweep, detection.startSample)
  const points = smoothResponsePoints(rawPoints.map((point) => ({
    ...point,
    magnitudeDb: point.magnitudeDb + micCompensationDbAtHz(micProfile, point.frequencyHz),
  })))
  return {
    status: signal.clippedSamples > 0 ? 'capture_clipped' : 'ok',
    rawPoints,
    points,
    micProfile: summarizeMicCalibrationProfile(micProfile),
    diagnostics: { ...baseDiagnostics, frequencyPoints: points.length },
  }
}
