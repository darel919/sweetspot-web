import { describe, expect, test } from 'bun:test'
import {
  CALIBRATION_CAPTURE_FRAME_HEADER_BYTES,
  decodeCalibrationCaptureFrame,
  encodeCalibrationCaptureFrame,
} from './calibrationCaptureFrame'
import {
  CALIBRATION_CAPTURE_FRAME_MAGIC,
  CALIBRATION_CAPTURE_FRAME_VERSION,
  MAX_CALIBRATION_CAPTURE_FRAME_BYTES,
  MAX_CALIBRATION_CAPTURE_METADATA_BYTES,
  type CalibrationCaptureFrameMetadata,
} from '../types/protocol'

const metadata: CalibrationCaptureFrameMetadata = {
  jobId: 'job-1',
  captureId: 'center-left-0',
  positionId: 'center',
  attemptIndex: 0,
  channel: 'left',
  sampleRate: 48_000,
  channelCount: 1,
  sampleCount: 3,
  byteCount: 12,
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
  contentSha256: 'a'.repeat(64),
}

describe('calibration capture frame', () => {
  test('round trips the SSCP header, metadata, and Float32 bytes', () => {
    const pcm = new Float32Array([0.25, -0.5, 1]).buffer
    const encoded = encodeCalibrationCaptureFrame({ metadata, pcm })
    const bytes = new Uint8Array(encoded)
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe(CALIBRATION_CAPTURE_FRAME_MAGIC)
    expect(new DataView(encoded).getUint32(4, false)).toBe(CALIBRATION_CAPTURE_FRAME_VERSION)
    const decoded = decodeCalibrationCaptureFrame(encoded)
    expect(decoded).toEqual({ ok: true, frame: { metadata, pcm } })
    if (decoded.ok) expect(Array.from(new Float32Array(decoded.frame.pcm))).toEqual([0.25, -0.5, 1])
  })

  test('rejects malformed headers and metadata before exposing PCM', () => {
    const pcm = new Float32Array([0]).buffer
    const encoded = encodeCalibrationCaptureFrame({ metadata: { ...metadata, sampleCount: 1, byteCount: 4 }, pcm })
    const badMagic = encoded.slice(0)
    new Uint8Array(badMagic)[0] = 0
    expect(decodeCalibrationCaptureFrame(badMagic)).toMatchObject({ ok: false, code: 'bad_magic' })

    const badVersion = encoded.slice(0)
    new DataView(badVersion).setUint32(4, 2, false)
    expect(decodeCalibrationCaptureFrame(badVersion)).toMatchObject({ ok: false, code: 'unsupported_version' })

    const badMetadataLength = encoded.slice(0)
    new DataView(badMetadataLength).setUint32(8, MAX_CALIBRATION_CAPTURE_METADATA_BYTES + 1, false)
    expect(decodeCalibrationCaptureFrame(badMetadataLength)).toMatchObject({ ok: false, code: 'metadata_too_large' })
  })

  test('rejects mismatched PCM lengths and oversized frames', () => {
    const mismatched = new Float32Array([0, 1]).buffer
    expect(() => encodeCalibrationCaptureFrame({ metadata, pcm: mismatched })).toThrow('PCM length')

    const oversized = new ArrayBuffer(MAX_CALIBRATION_CAPTURE_FRAME_BYTES)
    expect(() => encodeCalibrationCaptureFrame({
      metadata: { ...metadata, sampleCount: oversized.byteLength / 4, byteCount: oversized.byteLength },
      pcm: oversized,
    })).toThrow('frame limit')
  })

  test('keeps the fixed header length explicit', () => {
    expect(CALIBRATION_CAPTURE_FRAME_HEADER_BYTES).toBe(12)
  })
})
