#!/usr/bin/env bun

const bundlePath = Bun.argv[2]
const assertStatuses = Bun.argv.includes('--assert-status')
if (!bundlePath) {
  console.error('Usage: bun scripts/replay-calibration-debug.mjs <bundle.json>')
  process.exit(2)
}

const bundle = await Bun.file(bundlePath).json()
if (bundle?.schemaVersion !== 2 || !Array.isArray(bundle.captures) || typeof bundle.calibrationId !== 'string') {
  throw new Error('Unsupported calibration debug bundle.')
}

const { analyzeCompositeMeasurement } = await import('../app/lib/audio/measurement/response.ts')

function decodeFloat32(base64) {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.byteLength % 4 !== 0) throw new Error('PCM payload is not Float32-aligned.')
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice()
}

const results = bundle.captures.map((capture) => {
  const analysis = analyzeCompositeMeasurement(
    decodeFloat32(capture.pcmFloat32Base64),
    capture.sampleRate,
    capture.sweep,
    capture.microphoneProfile,
  )
  const newStatus = `${analysis.left.status}/${analysis.right.status}`
  return {
    context: capture.context,
    startSample: capture.startSample,
    endSample: capture.endSample,
    status: analysis.status,
    storedStatus: capture.analysisStatus,
    newStatus,
    statusChanged: capture.analysisStatus !== null && capture.analysisStatus !== newStatus,
    detection: analysis.detection,
    left: {
      status: analysis.left.status,
      diagnostics: analysis.left.diagnostics,
      responsePoints: analysis.left.displayPoints,
    },
    right: {
      status: analysis.right.status,
      diagnostics: analysis.right.diagnostics,
      responsePoints: analysis.right.displayPoints,
    },
  }
})

const changed = results.filter((result) => result.statusChanged)
if (assertStatuses && changed.length > 0) {
  for (const result of changed) {
    console.error(`Replay status changed at ${result.context.phase}/${result.context.positionId}/${result.context.attemptIndex}: ${result.storedStatus} -> ${result.newStatus}`)
  }
  process.exitCode = 1
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: bundle.schemaVersion,
  calibrationId: bundle.calibrationId,
  sessionIds: bundle.sessionIds,
  validationSessionIds: bundle.validationSessionIds,
  tvBuildId: bundle.tvBuildId,
  webBuildSha: bundle.webBuildSha,
  analysisRevision: bundle.analysisRevision,
  sweepRevision: bundle.sweepRevision,
  results,
}, null, 2)}\n`)
