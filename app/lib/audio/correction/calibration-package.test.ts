import { describe, expect, test } from 'bun:test'
import {
  CALIBRATION_PACKAGE_FORMAT,
  MAX_PAYLOAD_BYTES,
  CALIBRATION_PACKAGE_VERSION,
  type CalibrationPackage,
} from '../../../../shared/types/protocol'
import {
  calibrationPackageFilename,
  parseCalibrationPackageJson,
} from './calibration-package'

function makePackage(overrides: Partial<CalibrationPackage> = {}): CalibrationPackage {
  return {
    format: CALIBRATION_PACKAGE_FORMAT,
    version: CALIBRATION_PACKAGE_VERSION,
    exportedAt: 1_757_000_000_000,
    sourceDevice: { id: 'tv_test', name: 'Test TV', appVersion: '0.1.0' },
    active: true,
    frequenciesHz: Array.from({ length: 64 }, (_, index) => 20 + index * 10),
    bandsDb: Array.from({ length: 64 }, (_, index) => index % 3 === 0 ? -2 : 0),
    ...overrides,
  }
}

describe('portable calibration package', () => {
  test('parses a valid package with paired channels for import', () => {
    const pkg = makePackage({
      leftBandsDb: Array.from({ length: 64 }, () => -1),
      rightBandsDb: Array.from({ length: 64 }, () => -2),
    })
    const parsed = parseCalibrationPackageJson(JSON.stringify(pkg))

    expect(parsed).toEqual(pkg)
    expect(parsed?.leftBandsDb).toEqual(pkg.leftBandsDb)
    expect(parsed?.rightBandsDb).toEqual(pkg.rightBandsDb)
  })

  test('rejects malformed versions, frequency grids, gains, and unpaired channels', () => {
    const pkg = makePackage()
    expect(parseCalibrationPackageJson(JSON.stringify({ ...pkg, version: 2 }))).toBeNull()
    expect(parseCalibrationPackageJson(JSON.stringify({ ...pkg, frequenciesHz: [...pkg.frequenciesHz.slice(0, 63), 1] }))).toBeNull()
    expect(parseCalibrationPackageJson(JSON.stringify({ ...pkg, bandsDb: [...pkg.bandsDb.slice(0, 63), 13] }))).toBeNull()
    expect(parseCalibrationPackageJson(JSON.stringify({ ...pkg, leftBandsDb: Array.from({ length: 64 }, () => 1) }))).toBeNull()
  })

  test('creates a stable safe filename from the source device id', () => {
    expect(calibrationPackageFilename(makePackage({ sourceDevice: { id: 'tv/unsafe id', name: 'TV', appVersion: '0.1.0' } })))
      .toBe('sweetspot-calibration-tvunsafeid.json')
  })

  test('fits the relay envelope with effective stereo readback included', () => {
    const pkg = makePackage({
      leftBandsDb: Array.from({ length: 64 }, () => -1),
      rightBandsDb: Array.from({ length: 64 }, () => -2),
      effectiveBandsDb: Array.from({ length: 64 }, () => -1),
      effectiveLeftBandsDb: Array.from({ length: 64 }, () => -1),
      effectiveRightBandsDb: Array.from({ length: 64 }, () => -2),
    })
    expect(new TextEncoder().encode(JSON.stringify(pkg)).byteLength).toBeLessThan(MAX_PAYLOAD_BYTES)
  })
})
