#!/usr/bin/env bun

const bundlePath = Bun.argv[2]
if (!bundlePath) {
  console.error('Usage: bun scripts/replay-calibration-debug.mjs <bundle.json>')
  process.exit(2)
}

const bundle = await Bun.file(bundlePath).json()
if (bundle?.schemaVersion !== 1 || !Array.isArray(bundle.captures)) {
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
  return {
    context: capture.context,
    startSample: capture.startSample,
    endSample: capture.endSample,
    status: analysis.status,
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

process.stdout.write(`${JSON.stringify({
  schemaVersion: bundle.schemaVersion,
  sessionId: bundle.sessionId,
  webBuildSha: bundle.webBuildSha,
  analysisRevision: bundle.analysisRevision,
  sweepRevision: bundle.sweepRevision,
  results,
}, null, 2)}\n`)
