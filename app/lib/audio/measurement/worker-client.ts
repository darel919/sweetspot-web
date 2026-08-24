import type { MeasurementSweep } from '#shared/types/protocol'
import type { MeasurementAnalysis } from './response'
import type { MicCalibrationProfile } from '../mics/types'

interface MeasurementWorkerResponse {
  ok: boolean
  result?: MeasurementAnalysis
  error?: string
}

function isResponse(value: unknown): value is MeasurementWorkerResponse {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false
  if (value.ok === true) return 'result' in value && value.result !== undefined
  return value.ok === false && (!('error' in value) || typeof value.error === 'string')
}

export function analyzeInWorker(
  samples: Float32Array,
  sampleRate: number,
  sweep: MeasurementSweep,
  micProfile: MicCalibrationProfile,
): Promise<MeasurementAnalysis> {
  const worker = new Worker(new URL('../workers/measurement.worker.ts', import.meta.url), { type: 'module' })
  const transferableSamples = samples.slice()
  return new Promise((resolve, reject) => {
    const close = () => worker.terminate()
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const response = event.data
      if (!isResponse(response)) {
        close()
        reject(new Error('Measurement worker returned an invalid response.'))
        return
      }
      close()
      if (response.ok && response.result) {
        resolve(response.result)
      } else {
        reject(new Error(response.error ?? 'Measurement analysis failed.'))
      }
    }
    worker.onerror = () => {
      close()
      reject(new Error('Measurement worker failed.'))
    }
    worker.postMessage({
      samples: transferableSamples.buffer,
      sampleRate,
      sweep,
      micProfile,
    }, [transferableSamples.buffer])
  })
}
