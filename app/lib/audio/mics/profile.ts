import type {
  MicCalibrationPoint,
  MicCalibrationProfile,
  MicCalibrationSummary,
} from './types'

const MIC_TRUST_RAMP_TO_HZ = 50
const HF_COMPENSATION_CAP_START_HZ = 10_000
const HF_COMPENSATION_CAP_DB = 2
const HF_COMPENSATION_TAPER_CAP_DB = 1

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key]
  if (typeof candidate !== 'string' || candidate.length === 0) throw new Error(`Microphone profile requires ${key}`)
  return candidate
}

function requiredFiniteNumber(value: Record<string, unknown>, key: string): number {
  const candidate = value[key]
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) throw new Error(`Microphone profile requires finite ${key}`)
  return candidate
}

function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
  const candidate = value[key]
  if (typeof candidate !== 'boolean') throw new Error(`Microphone profile requires ${key}`)
  return candidate
}

function readPoint(value: unknown): MicCalibrationPoint {
  if (!isRecord(value)) throw new Error('Microphone profile points must be objects')
  const frequencyHz = requiredFiniteNumber(value, 'frequencyHz')
  const responseDb = requiredFiniteNumber(value, 'responseDb')
  if (frequencyHz <= 0) throw new Error('Microphone profile frequencies must be positive')
  return { frequencyHz, responseDb }
}

function readPoints(value: Record<string, unknown>): MicCalibrationPoint[] {
  if (!Array.isArray(value.points) || value.points.length < 2) {
    throw new Error('Microphone profile requires at least two points')
  }
  const points = value.points.map(readPoint)
  for (let index = 1; index < points.length; index++) {
    if (points[index].frequencyHz <= points[index - 1].frequencyHz) {
      throw new Error('Microphone profile frequencies must be strictly increasing')
    }
  }
  return points
}

function readTrust(value: Record<string, unknown>): MicCalibrationProfile['trust'] {
  if (!isRecord(value.trust)) throw new Error('Microphone profile requires trust')
  const trust = {
    minHz: requiredFiniteNumber(value.trust, 'minHz'),
    fullTrustMaxHz: requiredFiniteNumber(value.trust, 'fullTrustMaxHz'),
    taperToHz: requiredFiniteNumber(value.trust, 'taperToHz'),
  }
  if (!(trust.minHz > 0 && trust.minHz < trust.fullTrustMaxHz && trust.fullTrustMaxHz < trust.taperToHz)) {
    throw new Error('Microphone profile trust limits are invalid')
  }
  return trust
}

export function parseMicCalibrationProfile(input: unknown): MicCalibrationProfile {
  if (!isRecord(input)) throw new Error('Microphone profile must be an object')
  const referenceType = input.referenceType
  if (referenceType !== 'free-field' && referenceType !== 'pressure' && referenceType !== 'unknown') {
    throw new Error('Microphone profile referenceType is invalid')
  }
  const dataMethod = input.dataMethod
  if (dataMethod !== 'published-data' && dataMethod !== 'digitized-figure') {
    throw new Error('Microphone profile dataMethod is invalid')
  }
  if (!Array.isArray(input.publishedTraces) || input.publishedTraces.some((trace) => typeof trace !== 'string')) {
    throw new Error('Microphone profile publishedTraces is invalid')
  }
  const orientationsAveraged = requiredFiniteNumber(input, 'orientationsAveraged')
  if (!Number.isInteger(orientationsAveraged) || orientationsAveraged < 1) {
    throw new Error('Microphone profile orientationsAveraged is invalid')
  }
  const points = readPoints(input)
  const normalizeAtHz = requiredFiniteNumber(input, 'normalizeAtHz')
  if (normalizeAtHz < points[0].frequencyHz || normalizeAtHz > points[points.length - 1].frequencyHz) {
    throw new Error('Microphone profile normalizeAtHz is outside the profile range')
  }
  return {
    id: requiredString(input, 'id'),
    name: requiredString(input, 'name'),
    author: requiredString(input, 'author'),
    manufacturer: requiredString(input, 'manufacturer'),
    model: requiredString(input, 'model'),
    sourceUrl: requiredString(input, 'sourceUrl'),
    sourceDate: requiredString(input, 'sourceDate'),
    referenceType,
    sourceSmoothing: requiredString(input, 'sourceSmoothing'),
    capturePath: requiredString(input, 'capturePath'),
    dataMethod,
    normalizeAtHz,
    referenceMicrophone: requiredString(input, 'referenceMicrophone'),
    referenceMicSpacingMm: requiredFiniteNumber(input, 'referenceMicSpacingMm'),
    referenceMicSpacingApproximate: requiredBoolean(input, 'referenceMicSpacingApproximate'),
    measurementEnvironment: requiredString(input, 'measurementEnvironment'),
    excitation: requiredString(input, 'excitation'),
    orientationsAveraged,
    referenceCalibration: requiredString(input, 'referenceCalibration'),
    publishedTraces: [...input.publishedTraces],
    directivityMeasuredSeparately: requiredBoolean(input, 'directivityMeasuredSeparately'),
    points,
    trust: readTrust(input),
  }
}

export function interpolateLogResponseDb(profile: MicCalibrationProfile, frequencyHz: number): number {
  if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) return 0
  const points = profile.points
  const boundedFrequency = Math.max(points[0].frequencyHz, Math.min(points[points.length - 1].frequencyHz, frequencyHz))
  if (boundedFrequency <= points[0].frequencyHz) return points[0].responseDb
  if (boundedFrequency >= points[points.length - 1].frequencyHz) return points[points.length - 1].responseDb

  let low = 0
  let high = points.length - 1
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (points[middle].frequencyHz <= boundedFrequency) low = middle
    else high = middle
  }
  const lower = points[low]
  const upper = points[high]
  const position = Math.log(boundedFrequency / lower.frequencyHz) /
    Math.log(upper.frequencyHz / lower.frequencyHz)
  return lower.responseDb + (upper.responseDb - lower.responseDb) * position
}

function relativeMicResponseDbAtHz(profile: MicCalibrationProfile, frequencyHz: number): number {
  return interpolateLogResponseDb(profile, frequencyHz) - interpolateLogResponseDb(profile, profile.normalizeAtHz)
}

export function micTrustWeightAtHz(profile: MicCalibrationProfile, frequencyHz: number): number {
  const { minHz, fullTrustMaxHz, taperToHz } = profile.trust
  if (frequencyHz < minHz || frequencyHz >= taperToHz) return 0
  const rampToHz = Math.min(MIC_TRUST_RAMP_TO_HZ, fullTrustMaxHz)
  if (frequencyHz < rampToHz) return (frequencyHz - minHz) / (rampToHz - minHz)
  if (frequencyHz <= fullTrustMaxHz) return 1
  if (frequencyHz <= HF_COMPENSATION_CAP_START_HZ) {
    return 1 - 0.5 * (frequencyHz - fullTrustMaxHz) / (HF_COMPENSATION_CAP_START_HZ - fullTrustMaxHz)
  }
  return 0.5 * (taperToHz - frequencyHz) / (taperToHz - HF_COMPENSATION_CAP_START_HZ)
}

export function micCompensationDbAtHz(profile: MicCalibrationProfile, frequencyHz: number): number {
  const weightedCompensation = -relativeMicResponseDbAtHz(profile, frequencyHz) * micTrustWeightAtHz(profile, frequencyHz)
  const maximumAbsoluteCompensation = frequencyHz <= profile.trust.fullTrustMaxHz
    ? Number.POSITIVE_INFINITY
    : frequencyHz <= HF_COMPENSATION_CAP_START_HZ
      ? HF_COMPENSATION_CAP_DB
      : frequencyHz < profile.trust.taperToHz
        ? HF_COMPENSATION_TAPER_CAP_DB
        : 0
  if (maximumAbsoluteCompensation === 0) return 0
  return Math.max(-maximumAbsoluteCompensation, Math.min(maximumAbsoluteCompensation, weightedCompensation))
}

export function summarizeMicCalibrationProfile(profile: MicCalibrationProfile): MicCalibrationSummary {
  return {
    id: profile.id,
    name: profile.name,
    author: profile.author,
    sourceUrl: profile.sourceUrl,
    sourceDate: profile.sourceDate,
    referenceType: profile.referenceType,
    capturePath: profile.capturePath,
    dataMethod: profile.dataMethod,
  }
}
