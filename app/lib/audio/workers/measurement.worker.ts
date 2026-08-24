import { isMeasurementSweep } from '#shared/types/protocol'
import {
  analyzeMeasurement,
  type MeasurementAnalysis,
} from '../measurement/response'
import { parseMicCalibrationProfile } from '../mics/profile'

interface MeasurementWorkerRequest {
  samples: ArrayBuffer
  sampleRate: number
  sweep: unknown
  micProfile: unknown
}

interface MeasurementWorkerResponse {
  ok: boolean
  result?: MeasurementAnalysis
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
    if (!isMeasurementSweep(event.data.sweep)) throw new Error('Measurement worker received an invalid sweep.')
    const samples = new Float32Array(event.data.samples)
    const micProfile = parseMicCalibrationProfile(event.data.micProfile)
    const result = analyzeMeasurement(
      samples,
      event.data.sampleRate,
      event.data.sweep,
      micProfile,
    )
    self.postMessage({ ok: true, result })
  } catch (error: unknown) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'Measurement analysis failed.',
    })
  }
})
