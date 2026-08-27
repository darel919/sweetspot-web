import { generateCompositeSweepStereoReference } from '../app/lib/audio/sweep-reference.ts'

const sweep = {
  sweepRevision: 'android-sweep-v3',
  algorithm: 'exponential-sine-v1',
  captureKind: 'position-composite',
  markerChannel: 'left',
  sampleRate: 8_000,
  startHz: 20,
  endHz: 3_500,
  durationMs: 20,
  preRollMs: 10,
  postRollMs: 5,
  syncMarkerStartHz: 1_000,
  syncMarkerEndHz: 2_500,
  syncMarkerDurationMs: 4,
  syncMarkerGapMs: 1,
  endMarkerStartHz: 3_000,
  endMarkerEndHz: 1_200,
  endMarkerDurationMs: 4,
  interSweepGapMs: 1,
  sweepLevelDbfs: -12,
  markerLevelDbfs: -12,
  fadeInMs: 0,
  fadeOutMs: 0,
}

const reference = generateCompositeSweepStereoReference(sweep)
const pcm16 = Array.from(reference, (value) => Math.round(value * 32_767))
const output = `${JSON.stringify({ sweep, pcm16 }, null, 2)}\n`

await Bun.write(new URL('../test-vectors/measurement-sweep-golden.json', import.meta.url), output)
await Bun.write(new URL('../../sweetspot/app/src/test/resources/measurement-sweep-golden.json', import.meta.url), output)
