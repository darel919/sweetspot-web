import {
  CALIBRATION_CAPTURE_FRAME_MAGIC,
  CALIBRATION_CAPTURE_FRAME_VERSION,
  MAX_CALIBRATION_CAPTURE_FRAME_BYTES,
  MAX_CALIBRATION_CAPTURE_METADATA_BYTES,
  isCalibrationCaptureFrameMetadata,
  type CalibrationCaptureFrameMetadata,
} from '../types/protocol'

export const CALIBRATION_CAPTURE_FRAME_HEADER_BYTES = 12

export interface CalibrationCaptureFrame {
  metadata: CalibrationCaptureFrameMetadata
  pcm: ArrayBuffer
}

export type CalibrationCaptureFrameDecodeResult =
  | { ok: true; frame: CalibrationCaptureFrame }
  | {
      ok: false
      code: CalibrationCaptureFrameDecodeErrorCode
      message: string
    }

type CalibrationCaptureFrameDecodeErrorCode =
  | 'frame_too_small'
  | 'frame_too_large'
  | 'bad_magic'
  | 'unsupported_version'
  | 'metadata_too_large'
  | 'metadata_invalid'
  | 'pcm_length_mismatch'

const MAGIC_BYTES = new TextEncoder().encode(CALIBRATION_CAPTURE_FRAME_MAGIC)

function metadataBytes(metadata: CalibrationCaptureFrameMetadata): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(metadata))
}

function copiedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

export function encodeCalibrationCaptureFrame(frame: CalibrationCaptureFrame): ArrayBuffer {
  if (!isCalibrationCaptureFrameMetadata(frame.metadata)) {
    throw new TypeError('Calibration capture metadata is invalid')
  }
  if (frame.pcm.byteLength !== frame.metadata.byteCount || frame.pcm.byteLength % 4 !== 0) {
    throw new RangeError('Calibration capture PCM length does not match metadata')
  }
  const encodedMetadata = metadataBytes(frame.metadata)
  if (encodedMetadata.byteLength > MAX_CALIBRATION_CAPTURE_METADATA_BYTES) {
    throw new RangeError('Calibration capture metadata exceeds the frame limit')
  }
  const frameBytes = CALIBRATION_CAPTURE_FRAME_HEADER_BYTES
    + encodedMetadata.byteLength
    + frame.pcm.byteLength
  if (frameBytes > MAX_CALIBRATION_CAPTURE_FRAME_BYTES) {
    throw new RangeError('Calibration capture frame exceeds the frame limit')
  }
  const output = new ArrayBuffer(frameBytes)
  const outputBytes = new Uint8Array(output)
  outputBytes.set(MAGIC_BYTES)
  const header = new DataView(output)
  header.setUint32(4, CALIBRATION_CAPTURE_FRAME_VERSION, false)
  header.setUint32(8, encodedMetadata.byteLength, false)
  outputBytes.set(encodedMetadata, CALIBRATION_CAPTURE_FRAME_HEADER_BYTES)
  outputBytes.set(
    new Uint8Array(frame.pcm),
    CALIBRATION_CAPTURE_FRAME_HEADER_BYTES + encodedMetadata.byteLength,
  )
  return output
}

function failure(
  code: CalibrationCaptureFrameDecodeErrorCode,
  message: string,
): CalibrationCaptureFrameDecodeResult {
  return { ok: false, code, message }
}

export function decodeCalibrationCaptureFrame(
  input: ArrayBuffer | Uint8Array,
): CalibrationCaptureFrameDecodeResult {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength < CALIBRATION_CAPTURE_FRAME_HEADER_BYTES) {
    return failure('frame_too_small', 'Calibration capture frame header is incomplete')
  }
  if (bytes.byteLength > MAX_CALIBRATION_CAPTURE_FRAME_BYTES) {
    return failure('frame_too_large', 'Calibration capture frame exceeds the frame limit')
  }
  for (let index = 0; index < MAGIC_BYTES.byteLength; index++) {
    if (bytes[index] !== MAGIC_BYTES[index]) {
      return failure('bad_magic', 'Calibration capture frame magic does not match')
    }
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (header.getUint32(4, false) !== CALIBRATION_CAPTURE_FRAME_VERSION) {
    return failure('unsupported_version', 'Calibration capture frame version is unsupported')
  }
  const metadataLength = header.getUint32(8, false)
  if (metadataLength > MAX_CALIBRATION_CAPTURE_METADATA_BYTES) {
    return failure('metadata_too_large', 'Calibration capture metadata exceeds the frame limit')
  }
  const pcmOffset = CALIBRATION_CAPTURE_FRAME_HEADER_BYTES + metadataLength
  if (pcmOffset > bytes.byteLength) {
    return failure('frame_too_small', 'Calibration capture frame metadata is incomplete')
  }
  let metadataValue: unknown
  try {
    const metadataJson = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(CALIBRATION_CAPTURE_FRAME_HEADER_BYTES, pcmOffset),
    )
    metadataValue = JSON.parse(metadataJson)
  } catch {
    return failure('metadata_invalid', 'Calibration capture metadata is not valid UTF-8 JSON')
  }
  if (!isCalibrationCaptureFrameMetadata(metadataValue)) {
    return failure('metadata_invalid', 'Calibration capture metadata has an invalid shape')
  }
  const pcmBytes = bytes.byteLength - pcmOffset
  if (pcmBytes !== metadataValue.byteCount || pcmBytes % 4 !== 0) {
    return failure('pcm_length_mismatch', 'Calibration capture PCM length does not match metadata')
  }
  return {
    ok: true,
    frame: {
      metadata: metadataValue,
      pcm: copiedBuffer(bytes.subarray(pcmOffset)),
    },
  }
}
