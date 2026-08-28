import { describe, expect, test } from 'bun:test'
import {
  CALIBRATION_CAPTURE_STREAM_HEADER_BYTES,
  decodeCaptureStreamFrame,
  encodeCaptureBegin,
  encodeCaptureChunk,
  encodeCaptureEnd,
} from './captureStream'
import { MAX_CAPTURE_CHUNK_BYTES, MAX_CAPTURE_FRAME_BYTES } from './capabilities'
import type { CalibrationCaptureFrameMetadata } from '../types/protocol'
import transportFixture from '../../test-vectors/calibration-capture-stream.json'

const metadataBase = {
  jobId: 'job-1',
  captureId: 'capture-1',
  positionId: 'center',
  attemptIndex: 0,
  channel: 'both',
  sampleRate: 48_000,
  channelCount: 1 as const,
  settings: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
  userAgent: 'test browser',
  microphoneProfileId: 'iphone-17-pro',
  microphoneProfileRevision: '2026-08-24',
  microphoneProfile: {
    id: 'iphone-17-pro',
    revision: '2026-08-24',
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

const metadata: CalibrationCaptureFrameMetadata = {
  ...metadataBase,
  sampleCount: 3,
  byteCount: 12,
  contentSha256: 'a'.repeat(64),
}
const captureAttemptId = 'capture-attempt-1'

describe('calibration capture stream', () => {
  test('consumes the cross-repository capture vector', () => {
    const decodeFixture = (value: string): ArrayBuffer => {
      const decoded = atob(value)
      return Uint8Array.from(decoded, (character) => character.charCodeAt(0)).buffer
    }
    const begin = decodeCaptureStreamFrame(decodeFixture(transportFixture.beginBase64))
    const chunks = transportFixture.chunksBase64.map((frame) => decodeCaptureStreamFrame(decodeFixture(frame)))
    const end = decodeCaptureStreamFrame(decodeFixture(transportFixture.endBase64))
    const metadata = JSON.parse(atob(transportFixture.metadataJsonBase64)) as Record<string, unknown>

    expect(begin).toMatchObject({
      ok: true,
      frame: {
        kind: 'begin',
        sessionId: transportFixture.sessionId,
        captureId: transportFixture.captureId,
        captureAttemptId: transportFixture.captureAttemptId,
        metadata,
        expectedSampleCount: 4,
        expectedByteCount: 16,
      },
    })
    expect(chunks.every((frame) => frame.ok)).toBe(true)
    expect(chunks.map((frame) => frame.ok && frame.frame.kind === 'chunk' ? frame.frame.sampleCount : 0)).toEqual([2, 2])
    expect(end).toMatchObject({
      ok: true,
      frame: {
        kind: 'end',
        sessionId: transportFixture.sessionId,
        captureId: transportFixture.captureId,
        captureAttemptId: transportFixture.captureAttemptId,
        chunkCount: 2,
        finalSampleCount: 4,
        finalByteCount: 16,
        finalSha256: transportFixture.sha256,
      },
    })
    const pcm = Uint8Array.from(atob(transportFixture.pcmBase64), (character) => character.charCodeAt(0))
    expect(chunks.flatMap((frame) => frame.ok && frame.frame.kind === 'chunk'
      ? Array.from(new Uint8Array(frame.frame.pcm))
      : [])).toEqual(Array.from(pcm))
  })

  test('round trips begin, chunk, and end frames', () => {
    const begin = encodeCaptureBegin({
      sessionId: 'session-1',
      captureId: metadata.captureId,
      captureAttemptId,
      metadata: metadataBase,
      expectedSampleCount: metadata.sampleCount,
      expectedByteCount: metadata.byteCount,
    })
    expect(decodeCaptureStreamFrame(begin)).toEqual({
      ok: true,
      frame: {
        kind: 'begin',
        sessionId: 'session-1',
        captureId: metadata.captureId,
        captureAttemptId,
        metadata: metadataBase,
        expectedSampleCount: 3,
        expectedByteCount: 12,
      },
    })

    const pcm = new ArrayBuffer(12)
    const pcmView = new DataView(pcm)
    pcmView.setFloat32(0, 0.25, true)
    pcmView.setFloat32(4, -0.5, true)
    pcmView.setFloat32(8, 1, true)
    const chunk = encodeCaptureChunk({
      sessionId: 'session-1',
      captureId: metadata.captureId,
      captureAttemptId,
      sequence: 0,
      sampleCount: 3,
      pcm,
    })
    const decodedChunk = decodeCaptureStreamFrame(chunk)
    expect(decodedChunk.ok).toBe(true)
    if (decodedChunk.ok) {
      expect(decodedChunk.frame.kind).toBe('chunk')
      expect(Array.from(new Uint8Array(decodedChunk.frame.pcm))).toEqual(Array.from(new Uint8Array(pcm)))
    }

    const end = encodeCaptureEnd({
      sessionId: 'session-1',
      captureId: metadata.captureId,
      captureAttemptId,
      chunkCount: 1,
      finalSampleCount: metadata.sampleCount,
      finalByteCount: metadata.byteCount,
      finalSha256: metadata.contentSha256,
      metadata,
    })
    expect(decodeCaptureStreamFrame(end)).toEqual({
      ok: true,
      frame: {
        kind: 'end',
        sessionId: 'session-1',
        captureId: metadata.captureId,
        captureAttemptId,
        chunkCount: 1,
        finalSampleCount: 3,
        finalByteCount: 12,
        finalSha256: metadata.contentSha256,
        metadata,
      },
    })
  })

  test('keeps each PCM message below the transport budget', () => {
    const pcm = new ArrayBuffer(MAX_CAPTURE_CHUNK_BYTES)
    const encoded = encodeCaptureChunk({
      sessionId: 'session-1',
      captureId: metadata.captureId,
      captureAttemptId,
      sequence: 0,
      sampleCount: MAX_CAPTURE_CHUNK_BYTES / 4,
      pcm,
    })
    expect(encoded.byteLength).toBeLessThanOrEqual(MAX_CAPTURE_FRAME_BYTES)
    expect(encoded.byteLength).toBeGreaterThan(CALIBRATION_CAPTURE_STREAM_HEADER_BYTES)
  })

  test('rejects corrupted lengths and unsupported versions', () => {
    const encoded = encodeCaptureChunk({
      sessionId: 'session-1',
      captureId: metadata.captureId,
      captureAttemptId,
      sequence: 0,
      sampleCount: 1,
      pcm: new ArrayBuffer(4),
    })
    const wrongLength = encoded.slice(0)
    new DataView(wrongLength).setUint32(12, 8, false)
    expect(decodeCaptureStreamFrame(wrongLength)).toMatchObject({ ok: false, code: 'payload_invalid' })
    const wrongVersion = encoded.slice(0)
    new DataView(wrongVersion).setUint16(4, 2, false)
    expect(decodeCaptureStreamFrame(wrongVersion)).toMatchObject({ ok: false, code: 'unsupported_version' })
  })

  test('requires declared begin counts to be paired', () => {
    const encoded = encodeCaptureBegin({
      sessionId: 'session-1',
      captureId: metadata.captureId,
      captureAttemptId,
      metadata: metadataBase,
      expectedSampleCount: null,
      expectedByteCount: null,
    })
    const headerLength = new DataView(encoded).getUint32(8, false)
    const headerStart = CALIBRATION_CAPTURE_STREAM_HEADER_BYTES
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(encoded, headerStart, headerLength))) as Record<string, unknown>
    header.expectedByteCount = 4
    const headerBytes = new TextEncoder().encode(JSON.stringify(header))
    const malformed = new ArrayBuffer(encoded.byteLength + headerBytes.byteLength - headerLength)
    const malformedBytes = new Uint8Array(malformed)
    malformedBytes.set(new Uint8Array(encoded, 0, headerStart))
    new DataView(malformed).setUint32(8, headerBytes.byteLength, false)
    malformedBytes.set(headerBytes, headerStart)
    expect(decodeCaptureStreamFrame(malformed)).toMatchObject({ ok: false, code: 'header_invalid' })
  })

  test('rejects a chunk larger than the bounded PCM payload', () => {
    expect(() => encodeCaptureChunk({
      sessionId: 'session-1',
      captureId: metadata.captureId,
      captureAttemptId,
      sequence: 0,
      sampleCount: MAX_CAPTURE_CHUNK_BYTES / 4 + 1,
      pcm: new ArrayBuffer(MAX_CAPTURE_CHUNK_BYTES + 4),
    })).toThrow('chunk exceeds')
  })

  test('rejects an empty finalized capture', () => {
    expect(() => encodeCaptureEnd({
      sessionId: 'session-1',
      captureId: metadata.captureId,
      captureAttemptId,
      chunkCount: 0,
      finalSampleCount: metadata.sampleCount,
      finalByteCount: metadata.byteCount,
      finalSha256: metadata.contentSha256,
      metadata,
    })).toThrow()
  })
})
