import { access, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const webRoot = resolve(import.meta.dirname, '..')
const androidRoot = resolve(webRoot, '../sweetspot')

async function directFiles(path) {
  const entries = await readdir(path, { withFileTypes: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort()
}

async function assertEmpty(path, label) {
  const files = await directFiles(path)
  if (files.length > 0) throw new Error(`${label} contains unowned files: ${files.join(', ')}`)
}

async function assertOnly(path, label, expected) {
  const files = await directFiles(path)
  if (JSON.stringify(files) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} ownership differs. expected=${expected.join(', ')} actual=${files.join(', ')}`)
  }
}

async function assertExists(path, label) {
  try {
    await access(path)
  } catch {
    throw new Error(`${label} is missing: ${path}`)
  }
}

await assertEmpty(resolve(webRoot, 'app/composables'), 'web composables root')
await assertEmpty(resolve(webRoot, 'app/lib'), 'web library root')
await assertEmpty(resolve(androidRoot, 'app/src/main/java/com/darelisme/sweetspot'), 'Android package root')
await assertOnly(
  resolve(androidRoot, 'app/src/main/java/com/darelisme/sweetspot/calibration'),
  'Android calibration root',
  ['CalibrationEngine.kt'],
)

for (const [path, label] of [
  [resolve(webRoot, 'app/composables/calibration/useCalibrationSession.ts'), 'web calibration session'],
  [resolve(webRoot, 'app/composables/calibration/session-capture.ts'), 'web calibration capture analysis'],
  [resolve(webRoot, 'app/lib/audio/measurement/marker-detection.ts'), 'web marker detection'],
  [resolve(webRoot, 'app/lib/audio/measurement/session-result.ts'), 'web session result policy'],
  [resolve(webRoot, 'app/lib/transport/webrtc/peer.ts'), 'web WebRTC peer'],
  [resolve(webRoot, 'app/lib/transport/control/eq-command-revision.ts'), 'web control revision gate'],
  [resolve(androidRoot, 'app/src/main/java/com/darelisme/sweetspot/service/SweetSpotService.kt'), 'Android service'],
  [resolve(androidRoot, 'app/src/main/java/com/darelisme/sweetspot/diagnostics/SweetSpotDiagnosticsCoordinator.kt'), 'Android diagnostics'],
  [resolve(androidRoot, 'app/src/main/java/com/darelisme/sweetspot/calibration/playback/MeasurementController.kt'), 'Android measurement controller'],
  [resolve(androidRoot, 'app/src/main/java/com/darelisme/sweetspot/calibration/playback/MeasurementAudioRunner.kt'), 'Android measurement audio runner'],
]) {
  await assertExists(path, label)
}

console.log('Source ownership layout verified')
