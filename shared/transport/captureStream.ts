import {
  isCalibrationCaptureFrameMetadata,
  type CalibrationCaptureFrameMetadata,
  type CalibrationCaptureMetadata,
} from '../types/protocol'
import {
  CAPTURE_STREAM_VERSION,
  MAX_CAPTURE_CHUNK_BYTES,
  MAX_CAPTURE_FRAME_BYTES,
} from './capabilities'

export const CALIBRATION_CAPTURE_STREAM_MAGIC = 'SSCS' as const
export const CALIBRATION_CAPTURE_STREAM_HEADER_BYTES = 16

export type CalibrationCaptureStreamMetadata = Omit<CalibrationCaptureMetadata, 'sampleCount' | 'byteCount'>

export interface CaptureStreamBegin {
  kind: 'begin'
  sessionId: string
  captureId: string
  captureAttemptId: string
  metadata: CalibrationCaptureStreamMetadata
  expectedSampleCount: number | null
  expectedByteCount: number | null
}

export interface CaptureStreamChunk {
  kind: 'chunk'
  sessionId: string
  captureId: string
  captureAttemptId: string
  sequence: number
  sampleCount: number
  pcm: ArrayBuffer
}

export interface CaptureStreamEnd {
  kind: 'end'
  sessionId: string
  captureId: string
  captureAttemptId: string
  chunkCount: number
  finalSampleCount: number
  finalByteCount: number
  finalSha256: string
  metadata: CalibrationCaptureFrameMetadata
}

export type CalibrationCaptureStreamFrame = CaptureStreamBegin | CaptureStreamChunk | CaptureStreamEnd

export type CaptureStreamDecodeErrorCode =
  | 'frame_too_small'
  | 'frame_too_large'
  | 'bad_magic'
  | 'unsupported_version'
  | 'unknown_kind'
  | 'header_too_large'
  | 'header_invalid'
  | 'payload_invalid'

export type CaptureStreamDecodeResult =
  | { ok: true; frame: CalibrationCaptureStreamFrame }
  | { ok: false; code: CaptureStreamDecodeErrorCode; message: string }

interface CaptureStreamHeader {
  kind: unknown
  sessionId: string
  captureId: string
  captureAttemptId: string
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function isCount(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
}

function isPositiveCount(value: unknown): value is number {
  return isCount(value) && value > 0
}

function isNullableCount(value: unknown): value is number | null {
  return value === null || isPositiveCount(value)
}

function isBeginMetadata(value: unknown): value is CalibrationCaptureStreamMetadata {
  if (!isRecord(value)) return false
  return isCalibrationCaptureFrameMetadata({
    ...value,
    sampleCount: 1,
    byteCount: 4,
    contentSha256: '0'.repeat(64),
  })
}

function isBaseHeader(value: unknown): value is CaptureStreamHeader {
  return isRecord(value)
    && isBoundedId(value.sessionId)
    && isBoundedId(value.captureId)
    && isBoundedId(value.captureAttemptId)
}

function metadataBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const output = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(output).set(bytes)
  return output
}

function failure(code: CaptureStreamDecodeErrorCode, message: string): CaptureStreamDecodeResult {
  return { ok: false, code, message }
}

function encodeFrame(kind: number, header: unknown, payload: ArrayBuffer): ArrayBuffer {
  const headerBytes = metadataBytes(header)
  if (headerBytes.byteLength > 64 * 1024) throw new RangeError('Capture stream header exceeds the size limit')
  const frameBytes = CALIBRATION_CAPTURE_STREAM_HEADER_BYTES + headerBytes.byteLength + payload.byteLength
  if (frameBytes > MAX_CAPTURE_FRAME_BYTES) throw new RangeError('Capture stream frame exceeds the size limit')
  const output = new ArrayBuffer(frameBytes)
  const bytes = new Uint8Array(output)
  bytes.set(new TextEncoder().encode(CALIBRATION_CAPTURE_STREAM_MAGIC))
  const view = new DataView(output)
  view.setUint16(4, CAPTURE_STREAM_VERSION, false)
  view.setUint8(6, kind)
  view.setUint8(7, 0)
  view.setUint32(8, headerBytes.byteLength, false)
  view.setUint32(12, payload.byteLength, false)
  bytes.set(headerBytes, CALIBRATION_CAPTURE_STREAM_HEADER_BYTES)
  bytes.set(new Uint8Array(payload), CALIBRATION_CAPTURE_STREAM_HEADER_BYTES + headerBytes.byteLength)
  return output
}

export function encodeCaptureBegin(input: Omit<CaptureStreamBegin, 'kind'>): ArrayBuffer {
  if (!isBoundedId(input.sessionId) || !isBoundedId(input.captureId) || !isBoundedId(input.captureAttemptId)
    || !isBeginMetadata(input.metadata)
    || input.metadata.captureId !== input.captureId) {
    throw new TypeError('Capture stream begin metadata is invalid')
  }
  if (input.expectedSampleCount !== null && !isPositiveCount(input.expectedSampleCount)) {
    throw new RangeError('Capture stream expected sample count is invalid')
  }
  if (input.expectedByteCount !== null && !isPositiveCount(input.expectedByteCount)) {
    throw new RangeError('Capture stream expected byte count is invalid')
  }
  if ((input.expectedSampleCount === null) !== (input.expectedByteCount === null)) {
    throw new RangeError('Capture stream expected counts must be provided together')
  }
  if (input.expectedSampleCount !== null && input.expectedByteCount !== input.expectedSampleCount * 4) {
    throw new RangeError('Capture stream expected byte count does not match samples')
  }
  return encodeFrame(1, {
    kind: 'begin',
    sessionId: input.sessionId,
    captureId: input.captureId,
    captureAttemptId: input.captureAttemptId,
    metadata: input.metadata,
    expectedSampleCount: input.expectedSampleCount,
    expectedByteCount: input.expectedByteCount,
  }, new ArrayBuffer(0))
}

export function encodeCaptureChunk(input: Omit<CaptureStreamChunk, 'kind' | 'pcm'> & { pcm: ArrayBuffer | Uint8Array }): ArrayBuffer {
  const pcm = input.pcm instanceof Uint8Array ? copyBuffer(input.pcm) : input.pcm.slice(0)
  if (!isBoundedId(input.sessionId) || !isBoundedId(input.captureId) || !isBoundedId(input.captureAttemptId)
    || !isCount(input.sequence)) {
    throw new TypeError('Capture stream chunk identity is invalid')
  }
  if (!isCount(input.sampleCount) || input.sampleCount * 4 !== pcm.byteLength || pcm.byteLength === 0) {
    throw new RangeError('Capture stream chunk sample count does not match PCM')
  }
  if (pcm.byteLength > MAX_CAPTURE_CHUNK_BYTES) throw new RangeError('Capture stream chunk exceeds the size limit')
  return encodeFrame(2, {
    kind: 'chunk',
    sessionId: input.sessionId,
    captureId: input.captureId,
    captureAttemptId: input.captureAttemptId,
    sequence: input.sequence,
    sampleCount: input.sampleCount,
  }, pcm)
}

export function encodeCaptureEnd(input: Omit<CaptureStreamEnd, 'kind'>): ArrayBuffer {
  if (!isBoundedId(input.sessionId) || !isBoundedId(input.captureId) || !isBoundedId(input.captureAttemptId)
    || !isPositiveCount(input.chunkCount) || !isPositiveCount(input.finalSampleCount)
    || !isPositiveCount(input.finalByteCount) || input.finalByteCount !== input.finalSampleCount * 4
    || !/^[a-f0-9]{64}$/i.test(input.finalSha256)
    || !isCalibrationCaptureFrameMetadata(input.metadata)
    || input.metadata.captureId !== input.captureId
    || input.metadata.sampleCount !== input.finalSampleCount
    || input.metadata.byteCount !== input.finalByteCount
    || input.metadata.contentSha256.toLowerCase() !== input.finalSha256.toLowerCase()) {
    throw new TypeError('Capture stream end metadata is invalid')
  }
  return encodeFrame(3, {
    kind: 'end',
    sessionId: input.sessionId,
    captureId: input.captureId,
    captureAttemptId: input.captureAttemptId,
    chunkCount: input.chunkCount,
    finalSampleCount: input.finalSampleCount,
    finalByteCount: input.finalByteCount,
    finalSha256: input.finalSha256.toLowerCase(),
    metadata: input.metadata,
  }, new ArrayBuffer(0))
}

export function decodeCaptureStreamFrame(input: ArrayBuffer | Uint8Array): CaptureStreamDecodeResult {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength < CALIBRATION_CAPTURE_STREAM_HEADER_BYTES) {
    return failure('frame_too_small', 'Capture stream frame header is incomplete')
  }
  if (bytes.byteLength > MAX_CAPTURE_FRAME_BYTES) {
    return failure('frame_too_large', 'Capture stream frame exceeds the size limit')
  }
  const magic = new TextDecoder().decode(bytes.subarray(0, 4))
  if (magic !== CALIBRATION_CAPTURE_STREAM_MAGIC) return failure('bad_magic', 'Capture stream magic does not match')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint16(4, false) !== CAPTURE_STREAM_VERSION) return failure('unsupported_version', 'Capture stream version is unsupported')
  const kind = view.getUint8(6)
  if (view.getUint8(7) !== 0) return failure('header_invalid', 'Capture stream reserved header bits are not zero')
  const headerLength = view.getUint32(8, false)
  const payloadLength = view.getUint32(12, false)
  if (headerLength > 64 * 1024) return failure('header_too_large', 'Capture stream header exceeds the size limit')
  const payloadOffset = CALIBRATION_CAPTURE_STREAM_HEADER_BYTES + headerLength
  if (payloadOffset > bytes.byteLength || payloadOffset + payloadLength !== bytes.byteLength) {
    return failure('payload_invalid', 'Capture stream payload length does not match the frame')
  }
  let header: unknown
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(CALIBRATION_CAPTURE_STREAM_HEADER_BYTES, payloadOffset)))
  } catch {
    return failure('header_invalid', 'Capture stream header is not valid UTF-8 JSON')
  }
  if (!isBaseHeader(header) || typeof header.kind !== 'string' || header.kind !== (kind === 1 ? 'begin' : kind === 2 ? 'chunk' : kind === 3 ? 'end' : 'unknown')) {
    return kind >= 1 && kind <= 3
      ? failure('header_invalid', 'Capture stream header has the wrong kind')
      : failure('unknown_kind', 'Capture stream frame kind is unsupported')
  }
  if (kind === 1) {
    const metadata = header.metadata
    const expectedSampleCount = header.expectedSampleCount
    const expectedByteCount = header.expectedByteCount
    if (payloadLength !== 0 || !isBeginMetadata(metadata)
      || metadata.captureId !== header.captureId
      || !isNullableCount(expectedSampleCount)
      || !isNullableCount(expectedByteCount)
      || (expectedSampleCount === null) !== (expectedByteCount === null)
      || (expectedSampleCount !== null && expectedByteCount !== expectedSampleCount * 4)) {
      return failure('header_invalid', 'Capture stream begin header is invalid')
    }
    return {
      ok: true,
      frame: {
        kind: 'begin',
        sessionId: header.sessionId,
        captureId: header.captureId,
        captureAttemptId: header.captureAttemptId,
        metadata,
        expectedSampleCount,
        expectedByteCount,
      },
    }
  }
  if (kind === 2) {
    const sequence = header.sequence
    const sampleCount = header.sampleCount
    if (!isCount(sequence) || !isPositiveCount(sampleCount)
      || sampleCount * 4 !== payloadLength
      || payloadLength === 0 || payloadLength > MAX_CAPTURE_CHUNK_BYTES) {
      return failure('payload_invalid', 'Capture stream chunk payload is invalid')
    }
    return {
      ok: true,
      frame: {
        kind: 'chunk',
        sessionId: header.sessionId,
        captureId: header.captureId,
        captureAttemptId: header.captureAttemptId,
        sequence,
        sampleCount,
        pcm: copyBuffer(bytes.subarray(payloadOffset)),
      },
    }
  }
  const chunkCount = header.chunkCount
  const finalSampleCount = header.finalSampleCount
  const finalByteCount = header.finalByteCount
  const finalSha256 = header.finalSha256
  const metadata = header.metadata
  if (payloadLength !== 0 || !isCount(chunkCount) || !isPositiveCount(finalSampleCount)
    || !isPositiveCount(finalByteCount) || finalByteCount !== finalSampleCount * 4
    || typeof finalSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(finalSha256)
    || !isCalibrationCaptureFrameMetadata(metadata)
    || metadata.captureId !== header.captureId
    || metadata.sampleCount !== finalSampleCount
    || metadata.byteCount !== finalByteCount
    || metadata.contentSha256.toLowerCase() !== finalSha256.toLowerCase()) {
    return failure('header_invalid', 'Capture stream end header is invalid')
  }
  return {
    ok: true,
    frame: {
      kind: 'end',
      sessionId: header.sessionId,
      captureId: header.captureId,
      captureAttemptId: header.captureAttemptId,
      chunkCount,
      finalSampleCount,
      finalByteCount,
      finalSha256: finalSha256.toLowerCase(),
      metadata,
    },
  }
}
