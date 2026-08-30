import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  encodeCaptureBegin,
  encodeCaptureChunk,
  encodeCaptureEnd,
} from '../shared/transport/captureStream.ts'

const webRoot = resolve(import.meta.dirname, '..')
const androidRoot = resolve(webRoot, '../sweetspot')

const sessionId = 'fixture-session-1'
const jobId = 'fixture-job-1'
const captureId = 'fixture-capture-1'
const captureAttemptId = 'fixture-attempt-1'
const samples = [0.25, -0.5, 0.75, -1]
const pcm = new ArrayBuffer(samples.length * 4)
const pcmView = new DataView(pcm)
samples.forEach((sample, index) => pcmView.setFloat32(index * 4, sample, true))
const pcmBytes = new Uint8Array(pcm)
const sha256 = createHash('sha256').update(pcmBytes).digest('hex')
const metadataBase = {
  jobId,
  captureId,
  positionId: 'center',
  attemptIndex: 0,
  channel: 'both',
  sampleRate: 48_000,
  channelCount: 1,
  settings: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
  userAgent: 'transport-fixture',
  microphoneProfileId: 'fixture-mic',
  microphoneProfileRevision: 'fixture-v1',
  microphoneProfile: {
    id: 'fixture-mic',
    revision: 'fixture-v1',
    capturePathStatus: 'validated',
    frequenciesHz: [20, 20_000],
    responseDb: [0, 0],
    normalizeAtHz: 1_000,
    trustMinHz: 30,
    trustFullMaxHz: 8_000,
    trustTaperToHz: 12_000,
  },
  capturedAtMs: 1_757_000_000_000,
}
const metadata = {
  ...metadataBase,
  sampleCount: samples.length,
  byteCount: pcm.byteLength,
  contentSha256: sha256,
}
const chunkPcm = (start, end) => pcm.slice(start * 4, end * 4)
const begin = encodeCaptureBegin({
  sessionId,
  captureId,
  captureAttemptId,
  metadata: metadataBase,
  expectedSampleCount: samples.length,
  expectedByteCount: pcm.byteLength,
})
const chunks = [
  encodeCaptureChunk({ sessionId, captureId, captureAttemptId, sequence: 0, sampleCount: 2, pcm: chunkPcm(0, 2) }),
  encodeCaptureChunk({ sessionId, captureId, captureAttemptId, sequence: 1, sampleCount: 2, pcm: chunkPcm(2, 4) }),
]
const end = encodeCaptureEnd({
  sessionId,
  captureId,
  captureAttemptId,
  chunkCount: chunks.length,
  finalSampleCount: samples.length,
  finalByteCount: pcm.byteLength,
  finalSha256: sha256,
  metadata,
})

const base64 = (value) => Buffer.from(value).toString('base64')
const fixture = {
  version: 1,
  sessionId,
  jobId,
  captureId,
  captureAttemptId,
  metadataJsonBase64: Buffer.from(JSON.stringify(metadataBase)).toString('base64'),
  pcmBase64: base64(pcm),
  sha256,
  beginBase64: base64(begin),
  chunksBase64: chunks.map(base64),
  endBase64: base64(end),
}
const encoded = `${JSON.stringify(fixture, null, 2)}\n`

await mkdir(resolve(webRoot, 'test-vectors'), { recursive: true })
await mkdir(resolve(androidRoot, 'app/src/test/resources'), { recursive: true })
await Promise.all([
  writeFile(resolve(webRoot, 'test-vectors/calibration-capture-stream.json'), encoded),
  writeFile(resolve(androidRoot, 'app/src/test/resources/calibration-capture-stream.json'), encoded),
])
console.log('Generated the shared calibration capture transport fixture')
