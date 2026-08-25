import {
  isCalibrationPackage,
  type CalibrationPackage,
} from '../../../../shared/types/protocol'

export function parseCalibrationPackageJson(serialized: string): CalibrationPackage | null {
  try {
    const value: unknown = JSON.parse(serialized)
    return isCalibrationPackage(value) ? value : null
  } catch {
    return null
  }
}

export function calibrationPackageFilename(pkg: CalibrationPackage): string {
  const suffix = pkg.sourceDevice.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(-24) || 'tv'
  return `sweetspot-calibration-${suffix}.json`
}
