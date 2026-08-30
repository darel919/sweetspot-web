import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const androidRoot = resolve(process.env.SWEETSPOT_ANDROID_ROOT ?? resolve(root, '../../sweetspot'))
const webProtocol = await readFile(resolve(root, '../shared/types/protocol.ts'), 'utf8')
const androidProtocol = await readFile(resolve(androidRoot, 'app/src/main/java/com/darelisme/sweetspot/calibration/model/CalibrationProtocol.kt'), 'utf8')
const androidContext = await readFile(resolve(androidRoot, 'app/src/main/java/com/darelisme/sweetspot/calibration/model/MeasurementContext.kt'), 'utf8')

function literals(source, pattern, label) {
  const match = source.match(pattern)
  if (!match) throw new Error(`Could not locate ${label}.`)
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1])
}

function androidGeometry(source) {
  const match = source.match(/private fun positionTarget\(positionId: String\): MeasurementGeometry\? = when \(positionId\) \{([\s\S]*?)\n\s*else -> null/)
  if (!match) throw new Error('Could not locate Android position geometry.')
  return [...match[1].matchAll(/"(center|left|right|forward|backward)"\s*->\s*MeasurementGeometry\([^,]+,\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/g)]
    .map((entry) => [entry[1], Number(entry[2]), Number(entry[3]), Number(entry[4])])
}

const checks = [
  ['calibration error codes',
    literals(webProtocol, /export const CALIBRATION_ERROR_CODES = \[([\s\S]*?)\] as const/, 'web error codes'),
    literals(androidProtocol, /CALIBRATION_ERROR_CODES: Set<String> = setOf\(([\s\S]*?)\)/, 'Android error codes')],
  ['position ids',
    literals(webProtocol, /export type CalibrationPositionId = ([\s\S]*?)\n\n/, 'web position ids'),
    literals(androidContext, /POSITION_IDS = setOf\(([\s\S]*?)\)/, 'Android position ids')],
  ['measurement phases',
    literals(webProtocol, /export type MeasurementPhase = ([\s\S]*?)\n\n/, 'web phases'),
    literals(androidContext, /PHASES = setOf\(([\s\S]*?)\)/, 'Android phases')],
  ['measurement repair channels',
    literals(webProtocol, /export type MeasurementRepairChannel = ([\s\S]*?)\n\n/, 'web repair channels'),
    literals(androidContext, /CHANNELS = setOf\(([\s\S]*?)\)/, 'Android repair channels')],
  ['measurement capture kinds',
    literals(webProtocol, /export type MeasurementCaptureKind = ([\s\S]*?)\n\n/, 'web capture kinds'),
    literals(androidContext, /CAPTURE_KINDS = setOf\(([\s\S]*?)\)/, 'Android capture kinds')],
  ['measurement marker channels',
    literals(webProtocol, /export type MeasurementMarkerChannel = ([\s\S]*?)\n\n/, 'web marker channels'),
    literals(await readFile(resolve(androidRoot, 'app/src/main/java/com/darelisme/sweetspot/calibration/playback/MeasurementSweep.kt'), 'utf8'), /MARKER_CHANNELS = setOf\(([\s\S]*?)\)/, 'Android marker channels')],
]

for (const [label, webValues, androidValues] of checks) {
  const expected = [...new Set(webValues)].sort()
  const actual = [...new Set(androidValues)].sort()
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`${label} differ. web=${JSON.stringify(expected)} android=${JSON.stringify(actual)}`)
  }
}

const webGeometry = [...webProtocol.matchAll(/\s+(center|left|right|forward|backward): \{ reference: 'center', xCm: (-?\d+), yCm: (-?\d+), zCm: (-?\d+) \}/g)]
  .map((entry) => [entry[1], Number(entry[2]), Number(entry[3]), Number(entry[4])])
const actualGeometry = androidGeometry(androidContext)
if (JSON.stringify(webGeometry.sort()) !== JSON.stringify(actualGeometry.sort())) {
  throw new Error(`position geometry differs. web=${JSON.stringify(webGeometry)} android=${JSON.stringify(actualGeometry)}`)
}

const androidSweep = await readFile(resolve(androidRoot, 'app/src/main/java/com/darelisme/sweetspot/calibration/playback/MeasurementSweep.kt'), 'utf8')
const webSweepRevision = webProtocol.match(/CALIBRATION_SWEEP_REVISION = '([^']+)'/)?.[1]
const androidSweepRevision = androidSweep.match(/sweepRevision: String = "([^"]+)"/)?.[1]
if (!webSweepRevision || webSweepRevision !== androidSweepRevision) {
  throw new Error(`sweep revision differs. web=${webSweepRevision} android=${androidSweepRevision}`)
}

console.log('Protocol parity verified for errors, positions, geometry, phases, repair channels, capture kinds, marker channels, and sweep revision.')
