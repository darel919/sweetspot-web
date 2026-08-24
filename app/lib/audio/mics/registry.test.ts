import { describe, expect, test } from 'bun:test'
import { parseMicCalibrationProfile } from './profile'
import { parseMicCalibrationManifest } from './registry'

describe('microphone profile catalog', () => {
  test('accepts safe JSON profile filenames and preserves catalog order', () => {
    expect(parseMicCalibrationManifest({
      profiles: ['apple_iphone17pro_2025.json', 'studio_reference.json'],
    }).profiles).toEqual(['apple_iphone17pro_2025.json', 'studio_reference.json'])
  })

  test('rejects directory traversal, index self-reference, and duplicates', () => {
    expect(() => parseMicCalibrationManifest({ profiles: ['../profile.json'] })).toThrow()
    expect(() => parseMicCalibrationManifest({ profiles: ['index.json'] })).toThrow()
    expect(() => parseMicCalibrationManifest({ profiles: ['profile.json', 'profile.json'] })).toThrow()
  })

  test('the checked-in public catalog points to parseable profiles', async () => {
    const manifestInput: unknown = JSON.parse(await Bun.file('public/calibration/profiles/index.json').text())
    const manifest = parseMicCalibrationManifest(manifestInput)
    expect(manifest.profiles.length).toBeGreaterThan(0)

    for (const filename of manifest.profiles) {
      const profileInput: unknown = JSON.parse(await Bun.file(`public/calibration/profiles/${filename}`).text())
      const profile = parseMicCalibrationProfile(profileInput)
      expect(profile.points.length).toBeGreaterThan(100)
      expect(profile.points[0].frequencyHz).toBe(20)
      expect(profile.points[profile.points.length - 1].frequencyHz).toBe(20_000)
      expect(profile.id).toBe(filename.slice(0, -'.json'.length))
      for (let index = 1; index < profile.points.length; index++) {
        expect(profile.points[index].frequencyHz).toBeGreaterThan(profile.points[index - 1].frequencyHz)
      }
    }
  })
})
