interface CaptureTrackSettings {
  sampleRate: number | null
  channelCount: number | null
  echoCancellation: boolean | null
  noiseSuppression: boolean | null
  autoGainControl: boolean | null
}

interface CaptureCapabilityRange {
  min: number
  max: number
}

interface CaptureTrackCapabilities {
  sampleRate: CaptureCapabilityRange | null
  channelCount: CaptureCapabilityRange | null
  echoCancellation: boolean[]
  noiseSuppression: boolean[]
  autoGainControl: boolean[]
}

export interface MicrophoneCapture {
  stream: MediaStream
  track: MediaStreamTrack
  settings: CaptureTrackSettings
  capabilities: CaptureTrackCapabilities
}

type MicrophoneErrorCode = 'microphone_unavailable' | 'microphone_ended'

class MicrophoneCaptureError extends Error {
  readonly code: MicrophoneErrorCode

  constructor(code: MicrophoneErrorCode, message: string) {
    super(message)
    this.name = 'MicrophoneCaptureError'
    this.code = code
  }
}

function optionalNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readRange(value: { min?: number; max?: number } | undefined): CaptureCapabilityRange | null {
  if (!value || typeof value.min !== 'number' || typeof value.max !== 'number') return null
  if (!Number.isFinite(value.min) || !Number.isFinite(value.max)) return null
  return { min: value.min, max: value.max }
}

function readBooleanList(value: boolean[] | undefined): boolean[] {
  return value ? [...value] : []
}

function readSettings(track: MediaStreamTrack): CaptureTrackSettings {
  const settings = track.getSettings()
  return {
    sampleRate: optionalNumber(settings.sampleRate),
    channelCount: optionalNumber(settings.channelCount),
    echoCancellation: settings.echoCancellation ?? null,
    noiseSuppression: settings.noiseSuppression ?? null,
    autoGainControl: settings.autoGainControl ?? null,
  }
}

function readCapabilities(track: MediaStreamTrack): CaptureTrackCapabilities {
  if (typeof track.getCapabilities !== 'function') {
    return {
      sampleRate: null,
      channelCount: null,
      echoCancellation: [],
      noiseSuppression: [],
      autoGainControl: [],
    }
  }
  const capabilities = track.getCapabilities()
  return {
    sampleRate: readRange(capabilities.sampleRate),
    channelCount: readRange(capabilities.channelCount),
    echoCancellation: readBooleanList(capabilities.echoCancellation),
    noiseSuppression: readBooleanList(capabilities.noiseSuppression),
    autoGainControl: readBooleanList(capabilities.autoGainControl),
  }
}

function errorName(error: unknown): string | null {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) return error.name
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = error.name
    return typeof name === 'string' ? name : null
  }
  return null
}

export async function openMicrophone(): Promise<MicrophoneCapture> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new MicrophoneCaptureError('microphone_unavailable', 'This browser cannot provide microphone capture.')
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    })
  } catch (error: unknown) {
    const name = errorName(error)
    const message = name === 'NotReadableError'
      ? 'The microphone is busy or the browser denied audio focus.'
      : 'Microphone permission was denied or unavailable.'
    throw new MicrophoneCaptureError('microphone_unavailable', message)
  }

  const track = stream.getAudioTracks()[0]
  if (!track) {
    for (const streamTrack of stream.getTracks()) streamTrack.stop()
    throw new MicrophoneCaptureError('microphone_unavailable', 'The browser returned no audio track.')
  }
  if (track.readyState === 'ended') {
    for (const streamTrack of stream.getTracks()) streamTrack.stop()
    throw new MicrophoneCaptureError('microphone_ended', 'The microphone ended before capture could start.')
  }

  return {
    stream,
    track,
    settings: readSettings(track),
    capabilities: readCapabilities(track),
  }
}

export function closeMicrophone(capture: MicrophoneCapture): void {
  for (const track of capture.stream.getTracks()) track.stop()
}
