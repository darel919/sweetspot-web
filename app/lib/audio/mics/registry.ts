import { parseMicCalibrationProfile } from './profile'
import type { MicCalibrationProfile } from './types'

export interface MicCalibrationFileList {
  readonly files: readonly string[]
}

const PROFILE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseMicCalibrationFileList(input: unknown): MicCalibrationFileList {
  if (!isRecord(input) || !Array.isArray(input.files) || input.files.length === 0) {
    throw new Error('Microphone profile directory must contain a non-empty files array.')
  }

  const files = input.files.map((filename) => {
    if (typeof filename !== 'string' || !PROFILE_FILENAME.test(filename)) {
      throw new Error('Microphone profile directory contains an invalid filename.')
    }
    return filename
  })

  if (new Set(files).size !== files.length) {
    throw new Error('Microphone profile directory contains duplicate filenames.')
  }

  return { files }
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
  const fileList = parseMicCalibrationFileList(await fetchJson('/api/calibration/profiles'))
  return await Promise.all(fileList.files.map(async (filename) => {
    try {
      return parseMicCalibrationProfile(await fetchJson(profileUrl(basePath, filename)))
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : 'invalid profile data'
      throw new Error(`Could not load microphone profile ${filename}: ${detail}`)
    }
  }))
}
