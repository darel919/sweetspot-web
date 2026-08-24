import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { parseMicCalibrationProfile } from './profile'
import { parseMicCalibrationFileList } from './registry'

describe('microphone profile catalog', () => {
  test('accepts safe JSON profile filenames and preserves catalog order', () => {
    expect(parseMicCalibrationFileList({
      files: ['apple_iphone17pro_2025.json', 'studio_reference.json'],
    }).files).toEqual(['apple_iphone17pro_2025.json', 'studio_reference.json'])
  })

  test('rejects directory traversal and duplicates', () => {
    expect(() => parseMicCalibrationFileList({ files: ['../profile.json'] })).toThrow()
    expect(() => parseMicCalibrationFileList({ files: ['profile.json', 'profile.json'] })).toThrow()
  })

  test('the public profile directory contains parseable profiles', async () => {
    const entries = await readdir('public/calibration/profiles', { withFileTypes: true })
    const fileList = parseMicCalibrationFileList({
      files: entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
    })
    expect(fileList.files.length).toBeGreaterThan(0)

    for (const filename of fileList.files) {
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
