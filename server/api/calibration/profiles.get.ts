import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const PROFILE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/

export default defineEventHandler(async () => {
  const directory = resolve(process.cwd(), 'public/calibration/profiles')
  const entries = await readdir(directory, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && PROFILE_FILENAME.test(entry.name))
    .map((entry) => entry.name)
    .sort()

  if (files.length === 0) {
    throw createError({ statusCode: 500, statusMessage: 'No microphone calibration profiles are installed.' })
  }

  return { files }
})
