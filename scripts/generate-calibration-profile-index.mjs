import { readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const directory = fileURLToPath(new URL('../public/calibration/profiles/', import.meta.url))
const profileFilename = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/
const entries = await readdir(directory, { withFileTypes: true })
const profiles = entries
  .filter((entry) => entry.isFile() && entry.name !== 'index.json' && profileFilename.test(entry.name))
  .map((entry) => entry.name)
  .sort()

if (profiles.length === 0) throw new Error(`No calibration profiles found in ${directory}`)

await writeFile(
  new URL('../public/calibration/profiles/index.json', import.meta.url),
  `${JSON.stringify({ profiles }, null, 2)}\n`,
  'utf8',
)
