import { parseMicCalibrationProfile } from './profile'
import type { MicCalibrationProfile } from './types'

export interface MicCalibrationManifest {
  readonly profiles: readonly string[]
}

const PROFILE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseMicCalibrationManifest(input: unknown): MicCalibrationManifest {
  if (!isRecord(input) || !Array.isArray(input.profiles) || input.profiles.length === 0) {
    throw new Error('Microphone profile catalog must contain a non-empty profiles array.')
  }

  const profiles = input.profiles.map((filename) => {
    if (typeof filename !== 'string' || !PROFILE_FILENAME.test(filename) || filename === 'index.json') {
      throw new Error('Microphone profile catalog contains an invalid filename.')
    }
    return filename
  })

  if (new Set(profiles).size !== profiles.length) {
    throw new Error('Microphone profile catalog contains duplicate filenames.')
  }

  return { profiles }
}

function profileUrl(basePath: string, filename: string): string {
  const base = basePath.replace(/\/+$/, '')
  return `${base}/${encodeURIComponent(filename)}`
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`Could not load microphone profile resource (${response.status}).`)
  return await response.json()
}

export async function discoverMicCalibrationProfiles(
  basePath = '/calibration/profiles',
): Promise<MicCalibrationProfile[]> {
  const manifest = parseMicCalibrationManifest(await fetchJson(profileUrl(basePath, 'index.json')))
  return await Promise.all(manifest.profiles.map(async (filename) => {
    try {
      return parseMicCalibrationProfile(await fetchJson(profileUrl(basePath, filename)))
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : 'invalid profile data'
      throw new Error(`Could not load microphone profile ${filename}: ${detail}`)
    }
  }))
}
