import { isMeasurementSweep } from '#shared/types/protocol'
import {
  analyzeCompositeMeasurement,
  type CompositeMeasurementAnalysis,
} from '../measurement/response'
import { parseMicCalibrationProfile } from '../mics/profile'

interface MeasurementWorkerRequest {
  id: number
  samples: ArrayBuffer
  sampleRate: number
  sweep: unknown
  micProfile: unknown
}

interface MeasurementWorkerResponse {
  id: number
  ok: boolean
  result?: CompositeMeasurementAnalysis
  error?: string
}

interface MeasurementWorkerScope {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<MeasurementWorkerRequest>) => void,
  ): void
  postMessage(message: MeasurementWorkerResponse): void
}

declare const self: MeasurementWorkerScope

self.addEventListener('message', (event) => {
  try {
    if (!(event.data.samples instanceof ArrayBuffer)) {
      throw new Error('Measurement worker received an invalid PCM buffer.')
    }
    if (!Number.isFinite(event.data.sampleRate) || event.data.sampleRate <= 0) {
      throw new Error('Measurement worker received an invalid sample rate.')
    }
    if (!isMeasurementSweep(event.data.sweep)) throw new Error('Measurement worker received an invalid sweep.')
    const samples = new Float32Array(event.data.samples)
    const micProfile = parseMicCalibrationProfile(event.data.micProfile)
    const result = analyzeCompositeMeasurement(
      samples,
      event.data.sampleRate,
      event.data.sweep,
      micProfile,
    )
    self.postMessage({ id: event.data.id, ok: true, result })
  } catch (error: unknown) {
    self.postMessage({
      id: event.data.id,
      ok: false,
      error: error instanceof Error ? error.message : 'Measurement analysis failed.',
    })
  }
})
