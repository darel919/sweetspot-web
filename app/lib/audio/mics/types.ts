export interface MicCalibrationPoint {
  readonly frequencyHz: number
  readonly responseDb: number
}

export interface MicCalibrationTrust {
  readonly minHz: number
  readonly fullTrustMaxHz: number
  readonly taperToHz: number
}

export interface MicCalibrationProfile {
  readonly id: string
  readonly name: string
  readonly author: string
  readonly manufacturer: string
  readonly model: string
  readonly sourceUrl: string
  readonly sourceDate: string
  readonly referenceType: 'free-field' | 'pressure' | 'unknown'
  readonly sourceSmoothing: string
  readonly capturePath: string
  readonly dataMethod: 'published-data' | 'digitized-figure'
  readonly normalizeAtHz: number
  readonly referenceMicrophone: string
  readonly referenceMicSpacingMm: number
  readonly referenceMicSpacingApproximate: boolean
  readonly measurementEnvironment: string
  readonly excitation: string
  readonly orientationsAveraged: number
  readonly referenceCalibration: string
  readonly publishedTraces: readonly string[]
  readonly directivityMeasuredSeparately: boolean
  readonly points: readonly MicCalibrationPoint[]
  readonly trust: MicCalibrationTrust
}

export interface MicCalibrationSummary {
  readonly id: string
  readonly name: string
  readonly author: string
  readonly sourceUrl: string
  readonly sourceDate: string
  readonly referenceType: MicCalibrationProfile['referenceType']
  readonly capturePath: string
  readonly dataMethod: MicCalibrationProfile['dataMethod']
}
