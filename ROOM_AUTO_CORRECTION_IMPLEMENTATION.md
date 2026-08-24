# SweetSpot Room Auto-Correction Implementation

## Purpose

Implement a browser-driven room/speaker auto-correction system for SweetSpot using an iPhone as the measurement microphone and the Android TV as the sweep source + DSP endpoint.

Repositories:

- TV / Android / DSP: `https://github.com/darel919/SweetSpot`
- Web / phone measurement / optimizer: `https://github.com/darel919/sweetspot-web`

Hosted dashboard:

- `https://sweetspot.darelisme.my.id`

This is **speaker/room correction inspired by AutoEQ/Harman-style target matching**, not a literal copy of a Harman headphone target or AutoEQ's PEQ optimizer.

SweetSpot has a different DSP primitive: the TV already exposes a persistent 64-band `DynamicsProcessing` calibration layer plus a separate 24-band user EQ. The browser should measure the room, calculate a safe target error curve, reduce that result to the TV's 64 bands, and send it through the existing calibration protocol.

Do not move FFT/deconvolution/optimizer work onto the TV. Keep the TCL side lightweight.

---

# Current Architecture — Build On This, Do Not Recreate It

Before coding, inspect the current source in both repositories. The implementation has already moved beyond older planning documents.

## Android repo already has

- `DynamicsProcessingEq.kt`
- 64 internal calibration bands
- 24 user EQ bands
- calibration persistence
- global session-0 processing
- `SweetSpotService.kt`
- `MailboxClient.kt`
- pair-code relay transport
- `calibration.apply`
- `calibration.reset`
- API-only local web server

## Web repo already has

- Nuxt SPA
- `/connect/[code]`
- `useSweetSpotConnection.ts`
- shared protocol definitions
- Cloudflare Worker / Durable Object mailbox transport
- current EQ/profile/calibration UI
- reserved protocol names for:
  - `measurement.prepare`
  - `measurement.playSweep`
  - `measurement.abort`
  - `measurement.ready`
  - `measurement.started`
  - `measurement.finished`
  - `measurement.error`

Use the existing mailbox transport. **Do not replace it with a new WebSocket/Vercel architecture as part of this task.**

Raw microphone audio must never travel through the mailbox. The phone records and analyzes locally.

---

# Final Data Flow

```text
Android TV                                 iPhone Safari
──────────                                 ─────────────
prepare measurement  <──────────────────── calibration wizard
save transient state
bypass existing correction

start local PCM sweep ───── acoustic ─────> record microphone
                                             │
                                             ▼
                                      find/deconvolve sweep
                                             │
                                             ▼
                                      frequency response
                                             │
                                             ▼
                                    iPhone mic compensation
                                             │
                                             ▼
                                  multi-position aggregation
                                             │
                                             ▼
                                     SweetSpot target curve
                                             │
                                             ▼
                                    constrained correction
                                             │
                                             ▼
                                      map to 64 TV bands
                                             │
calibration.apply <───────────────────────────┘
        │
        ▼
64-band calibration + 24-band user EQ
        │
        ▼
headroom protection
        │
        ▼
global TV audio
```

---

# Non-Negotiable Design Rules

- [ ] Calibration EQ and user EQ remain separate layers.
- [ ] Do not overwrite user EQ when room calibration is applied.
- [ ] Measurement must temporarily bypass existing user EQ and calibration without losing persisted values.
- [ ] If measurement aborts, disconnects, times out, or throws, restore the exact prior audio state.
- [ ] Raw microphone PCM stays in the browser.
- [ ] No cloud FFT service.
- [ ] No FIR or mixed-phase correction in V1.
- [ ] No attempt to correct narrow room nulls with huge positive gain.
- [ ] Positive correction is forbidden unless headroom compensation is active and verified.
- [ ] High-frequency correction must be conservative because the iPhone 17 Pro bottom microphone becomes direction-dependent at high frequencies.
- [ ] Do not use AutoEQ headphone target files as speaker-room targets.

---

# Source iPhone 17 Pro Microphone Measurement

Use this as the built-in iPhone 17 Pro microphone profile source:

`https://www.faberacoustical.com/blog/2025/ios/iphone/measured-iphone-17-pro-microphone-frequency-response-and-directivity/`

Faber Acoustical measurement details that must be preserved as metadata:

- published September 25, 2025
- iPhone 17 Pro primary/bottom microphone
- lab reference microphone: PCB 378B02
- reference mic positioned approximately 1 mm from the iPhone mic
- anechoic chamber
- swept-sine excitation
- two orientations averaged by rotating the microphone jig 180°
- reference microphone factory calibration applied
- published pressure-corrected and free-field-corrected traces
- frequency-response graph uses 1/24-octave smoothing
- directivity measured separately around the bottom mic

For room/speaker measurement, use the **free-field-corrected trace** as the preferred profile basis.

## Important accuracy caveat

Faber routed the iPhone through SignalScope with **measurement mode enabled**.

Our Safari `getUserMedia()` capture path may not be identical to SignalScope's iOS measurement-mode audio session, even when we request:

```ts
{
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false
}
```

Therefore:

- [ ] Import the Faber curve as a real built-in profile.
- [ ] Mark it clearly in code metadata as a profile derived from the Faber SignalScope measurement path.
- [ ] Do not claim it is an exact Safari calibration until validated.
- [ ] Add a development validation procedure comparing Safari capture against SignalScope measurement-mode capture on the same iPhone 17 Pro and acoustic source.
- [ ] If Safari introduces a stable additional response delta, store a second compensation layer rather than modifying the original source profile.

Conceptually:

```text
final browser mic correction
    = Faber hardware/reference correction
    + Safari capture-path delta, if measured
```

---

# Import the iPhone 17 Pro Profile

Create a profile abstraction in `sweetspot-web`.

Suggested location:

```text
app/lib/audio/mics/types.ts
app/lib/audio/mics/iphone17ProFaber2025.ts
app/lib/audio/mics/index.ts
```

Suggested model:

```ts
export interface MicCalibrationPoint {
  frequencyHz: number
  responseDb: number
}

export interface MicCalibrationProfile {
  id: string
  name: string
  manufacturer: string
  model: string
  sourceUrl: string
  sourceDate: string
  referenceType: 'free-field' | 'pressure' | 'unknown'
  sourceSmoothing: string
  capturePath: string
  dataMethod: 'published-data' | 'digitized-figure'
  normalizeAtHz: number
  points: MicCalibrationPoint[]
  trust: {
    minHz: number
    fullTrustMaxHz: number
    taperToHz: number
  }
}
```

Profile ID:

```text
apple-iphone-17-pro-bottom-faber-2025-freefield
```

## The source article publishes a graph, not a numeric CSV

Do **not invent fake precision**.

Digitize the full-resolution published frequency-response figure into static frequency/response points and store those points in the repository.

Requirements:

- [ ] Use the free-field trace.
- [ ] Sample on a logarithmic frequency axis.
- [ ] Prefer at least approximately 1/12-octave point density; 1/24-octave is acceptable if digitization is clean.
- [ ] Normalize the imported curve consistently, preferably 1 kHz = 0 dB.
- [ ] Store the original article URL in metadata.
- [ ] Set `dataMethod: 'digitized-figure'` unless Faber later publishes numeric data.
- [ ] Add a comment explaining that the values are digitized from the published figure rather than supplied as an official calibration file.
- [ ] Add a small test checking frequencies are strictly increasing and contain no NaN/Infinity.

Compensation applied to a measured room response is the inverse:

```text
correctedRoomDb(f) = measuredDb(f) - micResponseDb(f)
```

Do not permanently modify the original profile points to store the inverse. Keep source response and compensation conceptually separate.

---

# iPhone 17 Pro Orientation Requirement

Faber's directivity measurement shows that the iPhone 17 Pro bottom microphone is approximately omnidirectional at lower frequencies but becomes substantially direction-dependent in the high treble.

The calibration wizard must therefore tell the user to keep one consistent orientation.

Recommended instruction:

```text
Hold the iPhone at ear height.
Point the bottom/USB-C edge toward the center of the speakers.
Keep the same orientation for every measurement position.
Do not cover the bottom microphone.
```

Do not rely on the user pointing the screen toward the TV; explicitly reference the bottom/USB-C edge.

The iPhone 17 Pro changed the bottom mic location to the opposite side of the USB-C connector compared with previous Pro generations, so do not reuse an older iPhone illustration blindly.

---

# Frequency Trust Weighting for the iPhone Profile

Do not simply invert every visible wiggle in the microphone graph.

Use a frequency-dependent microphone confidence weight.

Initial recommendation:

```text
< 30 Hz       very low trust
30–50 Hz      ramp up
50 Hz–8 kHz   full trust
8–10 kHz      still useful, begin reducing correction aggression
10–12 kHz     taper strongly
> 12 kHz      do not use narrow compensation features
```

The exact crossover values should be centralized constants and easy to tune.

Above ~10 kHz:

- only correct very broad trends
- cap microphone-derived compensation magnitude
- do not create narrow inverse features
- never chase the strong 16 kHz directional behavior

This is intentionally conservative. A slightly imperfect treble target is preferable to creating a huge position/orientation-specific EQ artifact.

---

# Browser Microphone Capture

Create a dedicated browser measurement module rather than placing DSP code directly in `[code].vue`.

Suggested structure:

```text
app/lib/audio/
  capture/
    microphone.ts
    pcm-recorder.ts
  measurement/
    sweep-reference.ts
    deconvolution.ts
    response.ts
    smoothing.ts
  mics/
    types.ts
    iphone17ProFaber2025.ts
  correction/
    target.ts
    optimizer.ts
    bandMapper.ts
  workers/
    measurement.worker.ts
```

The exact file names may change, but keep UI, capture, analysis, and optimizer separated.

## getUserMedia

Request:

```ts
navigator.mediaDevices.getUserMedia({
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  },
})
```

Then read:

```ts
track.getSettings()
track.getCapabilities?.()
```

Never assume all requested constraints were honored.

Display a development diagnostics view containing:

- actual sample rate
- channel count
- echo cancellation state when exposed
- noise suppression state when exposed
- AGC state when exposed
- live RMS
- peak level
- clipping indicator

## Capture PCM, not compressed MediaRecorder output

For analysis, prefer:

```text
MediaStream
    ↓
AudioContext
    ↓
AudioWorklet
    ↓
Float32 PCM chunks
    ↓
Web Worker
```

Avoid AAC/Opus/MediaRecorder as the primary measurement signal path.

Keep recording duration bounded so memory stays predictable.

---

# Android Measurement Controller

Add a service-owned measurement component in `SweetSpot`.

Suggested file:

```text
app/src/main/java/com/darelisme/sweetspot/MeasurementController.kt
```

Do not place sweep generation or measurement state logic inside `MailboxClient`.

`MailboxClient` should only transport commands.

`SweetSpotService` should route measurement messages into `MeasurementController`.

The controller owns:

- transient measurement session ID
- saved pre-measurement DSP state
- temporary bypass
- AudioFocus request/release
- `AudioTrack`
- sweep generation/playback
- timeout
- abort/restore

---

# Transient Measurement Bypass

Do not call normal persisted setters to fake a flat state.

Current engine setters save state. Measurement needs a transient path.

Add an explicit non-persistent measurement bypass API.

Possible design:

```kotlin
interface MeasurementAwareAudioEngine {
    fun beginMeasurementBypass(): MeasurementAudioState
    fun endMeasurementBypass(state: MeasurementAudioState)
}
```

or an equivalent method on `DynamicsProcessingEq`.

Requirements:

- [ ] Save whether DSP was enabled.
- [ ] Preserve all 24 user EQ values.
- [ ] Preserve all 64 calibration values.
- [ ] Preserve active calibration flag.
- [ ] Preserve input gain/headroom state when that feature is added.
- [ ] Make the live path flat for the sweep.
- [ ] Do not write the flat state into `ProfileStore`.
- [ ] Restore exactly once after finish/abort/timeout.
- [ ] Be safe if abort is called twice.

The simplest valid implementation may temporarily disable the production `DynamicsProcessing` effect without persisting that disabled state, as long as the sweep is confirmed to bypass processing and normal state is restored afterward.

---

# Sweep Generator

Use generated PCM with `AudioTrack`. Do not ship a large WAV asset.

Initial deterministic sweep:

```text
type             exponential sine sweep
start            20 Hz
end              20 kHz
duration          8.0 s
pre-roll silence  1.0 s
post-roll silence 1.0 s
nominal level    -12 dBFS
sample rate       prefer 48 kHz; report actual
channels          stereo signal identical in V1
```

Add a short amplitude fade at sweep start/end to prevent clicks.

Use one shared mathematical definition between the TV generator and the browser reference generator.

A standard exponential sweep can be defined from:

```text
K = T / ln(f2 / f1)
phase(t) = 2π f1 K (exp(t / K) - 1)
x(t) = A sin(phase(t))
```

where:

- `T` = sweep duration
- `f1` = start frequency
- `f2` = end frequency
- `A` = linear amplitude corresponding to configured dBFS

The browser should generate its reference from the parameters returned by the TV. Do not maintain two unrelated hardcoded sweep files.

---

# Measurement Protocol

Extend the existing protocol types instead of inventing a second API.

Add concrete payload interfaces for the already-reserved message names.

Example:

```ts
interface MeasurementPreparePayload {
  sessionId: string
  channel: 'both' | 'left' | 'right'
}

interface MeasurementReadyPayload {
  sessionId: string
  sweep: {
    sampleRate: number
    startHz: number
    endHz: number
    durationMs: number
    preRollMs: number
    postRollMs: number
    levelDbfs: number
  }
}

interface MeasurementPlaySweepPayload {
  sessionId: string
}

interface MeasurementStartedPayload {
  sessionId: string
  sweep: MeasurementReadyPayload['sweep']
}

interface MeasurementFinishedPayload {
  sessionId: string
}

interface MeasurementAbortPayload {
  sessionId: string
}
```

The phone must start recording **before** sending `measurement.playSweep`.

Do not synchronize phone and TV clocks.

Mailbox/network latency does not matter acoustically because the browser finds the sweep inside the captured PCM.

---

# Measurement Session Sequence

Implement this exact state machine conceptually:

```text
idle
 ↓
prepare requested
 ↓
TV stores state + transiently bypasses EQ
 ↓
measurement.ready
 ↓
phone starts PCM capture
 ↓
phone waits ~250–500 ms
 ↓
measurement.playSweep
 ↓
TV plays sweep
 ↓
measurement.started   (UX/status only)
 ↓
measurement.finished
 ↓
phone records post-roll
 ↓
phone stops capture
 ↓
TV restores previous audio state
 ↓
browser analyzes PCM
 ↓
ready for next position
```

Add a TV-side timeout so an abandoned browser cannot leave the TV in measurement bypass.

Recommended initial timeout:

```text
30 seconds after prepare/play activity
```

Reset timeout while an active sweep is being played.

---

# Sweep Detection and Deconvolution

Heavy analysis must run in a Web Worker.

Do not block Vue rendering.

Recommended pipeline:

```text
captured Float32 PCM
       ↓
DC removal
       ↓
clipping / SNR validation
       ↓
locate sweep using correlation / matched reference
       ↓
trim useful region
       ↓
log-sweep deconvolution / inverse sweep
       ↓
impulse response
       ↓
reasonable room-response window
       ↓
FFT
       ↓
magnitude response
```

V1 only needs magnitude.

Do not implement phase correction.

Use a regularized inverse/deconvolution so bins with negligible reference energy cannot explode numerically.

Return structured diagnostics including:

```ts
interface MeasurementDiagnostics {
  clipped: boolean
  peakDbfs: number
  rmsDbfs: number
  detectedSweepOffsetSamples: number
  snrEstimateDb: number
  sampleRate: number
}
```

Reject the measurement when:

- obvious clipping occurred
- sweep cannot be found
- signal level is too low
- sample rate is unsupported/unexpected and cannot be handled

The UI should ask the user to repeat that position rather than generating correction from bad data.

---

# Frequency Grid

Use a dense internal logarithmic analysis grid independent of the TV's 64 bands.

Suggested analysis output:

```text
20 Hz – 20 kHz
1/24-octave or denser internal points
```

Then produce smoothed views as needed.

Do not make the FFT frequency-bin grid itself the public correction grid.

---

# Smoothing

Keep distinct concepts:

1. raw magnitude
2. display smoothing
3. optimizer smoothing

Suggested defaults:

```text
display response:     1/12 octave
optimizer response:   1/6 octave or adaptive
mic profile source:   source is already 1/24-oct smoothed
```

Do not apply the same smoothing operation repeatedly until the response becomes artificially flat.

Narrow comb-filter structure should generally not turn into narrow correction filters.

---

# Single-Position Repeatability Gate

Before writing automatic correction, prove measurement repeatability.

Development test:

- [ ] Put the phone on a fixed stand.
- [ ] Keep TV volume unchanged.
- [ ] Run at least 3 sweeps.
- [ ] Apply the same mic compensation to all 3.
- [ ] Overlay the smoothed curves.

Target:

```text
approximately ±1 dB agreement through most of the useful range
```

Ignore extreme LF where room/noise dominates and extreme HF where phone orientation causes instability.

If repeatability is poor, stop and fix capture/sweep/deconvolution. Do not compensate instability with stronger smoothing.

---

# Calibration Wizard UX

The normal user should see a guided workflow, not DSP internals.

Add a dedicated calibration route/component instead of expanding the existing calibration JSON textarea forever.

Suggested interaction:

```text
Calibrate SweetSpot

1. Pause music/video playback.
2. Set the TV to your normal listening volume.
3. Allow microphone access.
4. Hold iPhone at ear height.
5. Point the bottom/USB-C edge toward the speakers.

Microphone:
[iPhone 17 Pro — Faber 2025 ▼]

[Start calibration]
```

Then position guidance:

```text
Position 1 — normal head position
Position 2 — ~20 cm left
Position 3 — ~20 cm right
Position 4 — ~20 cm forward/up
Position 5 — ~20 cm backward/down
```

Do not ask the user to measure the whole room. Optimize the listening zone.

Provide a quicker one-position mode for development and later as an advanced/quick option.

---

# Multi-Position Aggregation

Standard mode should use 5 nearby measurements.

Retain every individual response.

Do not average dB values blindly without considering outliers.

Start with a robust spatial magnitude estimate such as:

```text
combined(f) = weighted median / trimmed mean of measurements in dB
```

or a center-weighted mean after rejecting strong outliers.

Calculate per-frequency spread:

```text
spreadDb(f)
```

Use spread as correction confidence.

Example behavior:

```text
All 5 positions show +7 dB at 80 Hz
→ high-confidence room peak
→ cut strongly

1 position shows -12 dB at 130 Hz, others near target
→ spatial null
→ do not boost
```

Initial confidence concept:

```text
spread <= 2 dB   high confidence
2–4 dB           moderate confidence
> 4 dB           low confidence for boosts
```

Keep these constants centralized.

---

# SweetSpot Default Room Target

Do not use a headphone Harman target.

Use a gently downward-sloping in-room target with modest bass rise.

Initial anchor points for a default SweetSpot target:

```text
20 Hz     +4.0 dB
30 Hz     +4.0 dB
60 Hz     +3.5 dB
100 Hz    +3.0 dB
200 Hz    +1.5 dB
500 Hz    +0.5 dB
1 kHz      0.0 dB
2 kHz     -0.5 dB
5 kHz     -1.5 dB
10 kHz    -2.5 dB
20 kHz    -3.0 dB
```

Interpolate in log-frequency space.

Treat these as tuneable SweetSpot defaults, not a claim that they are the one universal Harman loudspeaker curve.

Later expose simple controls:

```text
Bass
Tilt
Correction strength
```

Do not expose 30 target-curve parameters in the first user-facing wizard.

---

# Detect Speaker Low-Frequency Extension

The optimizer must not demand impossible bass output.

Estimate speaker LF extension from the robust combined response.

One reasonable V1 heuristic:

- calculate a stable midbass/reference level around ~100–300 Hz
- find the lowest frequency where response remains within ~6 dB of that reference over a broad region
- confirm it is a broad rolloff, not a single room dip

Call this approximately:

```text
lfExtensionHz
```

Below that point, progressively bend the target toward the measured natural rolloff.

Never produce +10 dB or +20 dB attempting to extend a small TV/speaker system to 20 Hz.

---

# Correction Algorithm

The optimizer should conceptually compute:

```text
errorDb(f) = targetDb(f) - measuredCombinedDb(f)
```

Then apply safety and confidence constraints before reducing to 64 bands.

Suggested processing order:

```text
measured individual responses
        ↓
mic compensation
        ↓
spatial robust aggregation
        ↓
target curve
        ↓
error curve
        ↓
frequency smoothing
        ↓
spatial confidence weighting
        ↓
LF-extension protection
        ↓
boost/cut limits
        ↓
HF trust weighting
        ↓
correction strength
        ↓
map/integrate to TV bands
```

Initial limits:

```text
maximum cut:   -9 dB
maximum boost: +3 dB
```

Correction aggression by range:

```text
20–200 Hz      strongest
200 Hz–1 kHz   moderate
1–8 kHz        gentle / broad
8–12 kHz       conservative
>12 kHz        broad trend only or no correction
```

Rules:

- [ ] Prefer cuts over boosts.
- [ ] Broad repeatable peaks are excellent correction candidates.
- [ ] Deep narrow nulls receive no boost.
- [ ] Low-confidence regions receive reduced correction.
- [ ] No boost below detected LF extension.
- [ ] Do not invert narrow high-frequency iPhone mic artifacts.
- [ ] Limit rate-of-change between adjacent correction bands.

Add an adjustable overall strength:

```text
Off      0.0
Gentle   ~0.5
Normal   ~0.75
Strong   ~1.0
```

Default to `Normal`, not maximum aggression.

---

# Mapping the Correction to Android DynamicsProcessing

Important: inspect Android `DynamicsProcessing.EqBand` semantics before implementing the mapper.

Current `DynamicsProcessingProbe.buildConfig()` creates 64 logarithmically spaced `EqBand` cutoff frequencies from 20 Hz to 20 kHz. The Android API treats `cutoffFrequency` as a band boundary/upper cutoff, not a classic parametric-EQ center frequency.

Do not treat the TV as 64 independent narrow PEQ filters with Q values.

Create a mapper that integrates/averages the safe correction over each actual TV EQ band.

Conceptually:

```text
band 0: lower limit -> cutoff[0]
band 1: cutoff[0]   -> cutoff[1]
...
band N: cutoff[N-1] -> cutoff[N]
```

For log-spaced regions, use log-frequency weighting when averaging the desired correction inside a band.

The final output remains:

```ts
number[64] // dB
```

and can use the existing:

```text
calibration.apply
```

Do not port AutoEQ's parametric filter/Q optimizer onto this graphic/cutoff-band DSP.

---

# Headroom Protection

The current engine calculates effective EQ approximately as:

```text
calibration + user EQ
```

Automatic positive boosts require a matching preamp/headroom reduction.

Add headroom calculation before allowing `maxBoost > 0`.

Concept:

```text
maxEffectiveBoostDb = max(calibrationBand + mappedUserEqContribution)
requiredPreampDb = -(maxEffectiveBoostDb + safetyMarginDb)
```

Initial safety margin:

```text
0.5 dB
```

Use `DynamicsProcessing` channel input gain if it works reliably on the target TV.

Requirements:

- [ ] Apply identical input gain to all active output channels.
- [ ] Recalculate after calibration changes.
- [ ] Recalculate after user EQ changes.
- [ ] Persist enough state to restore correctly after service restart.
- [ ] Expose current automatic headroom in diagnostics/state.

If input gain cannot be trusted on the TCL:

```text
max positive automatic correction = 0 dB
```

Do not permit clipping merely to preserve boost behavior.

---

# Apply + Validate

Auto-correction is not complete after computing a pretty predicted graph.

After applying the generated 64-band calibration:

- [ ] Ask user to keep the phone at the center listening position.
- [ ] Run one verification sweep.
- [ ] Apply the same mic profile and analysis pipeline.
- [ ] Show before / target / after.
- [ ] Compute improvement metrics.

Useful metrics:

```text
RMS target error before
RMS target error after
20–200 Hz RMS error before/after
maximum correction boost
maximum correction cut
headroom attenuation
```

Do not over-score extreme high-frequency changes where the phone profile has low confidence.

If the verification result is substantially worse than prediction, do not silently keep an aggressive curve. Offer:

```text
Use gentler correction
Retry measurement
Keep correction anyway (advanced)
```

---

# Before / Target / After Graph

Display on a logarithmic frequency axis.

At minimum show:

```text
Before
Target
After
```

Advanced details can show:

```text
individual measurement positions
mic compensation curve
final 64-band correction
confidence/spread
speaker LF extension
```

The default UI should remain understandable without acoustic expertise.

---

# Protocol Additions

Add concrete shared TypeScript payload types for measurement messages already listed in `KNOWN_TYPES`.

Add Android JSON handling for the same exact contract.

Do not add a separate endpoint for each calibration action unless the existing mailbox design genuinely requires it.

Likely commands/replies:

```text
measurement.prepare
measurement.ready
measurement.playSweep
measurement.started
measurement.finished
measurement.abort
measurement.error
calibration.apply       // already exists
calibration.reset       // already exists
```

Future optional:

```text
measurement.playTone
measurement.setChannel
```

Keep protocol version `v = 1` if additions are backward-compatible optional capabilities.

Add a capability flag rather than assuming every installed APK supports measurement:

```ts
supportsSweep: boolean
```

This already exists in `DeviceCapabilities`; make it report the real implementation state.

---

# Measurement Capability Must Be Honest

Until sweep playback is actually implemented and tested:

```text
supportsSweep = false
```

After implementation passes on the TCL:

```text
supportsSweep = true
```

The web wizard must refuse auto-calibration gracefully on older APKs and explain that the TV app needs an update.

---

# Stereo / Per-Channel Correction

Do **not** block the first working version on separate left/right correction.

First complete a common stereo room-correction curve.

After V1 is stable, add:

```text
left-only sweep
right-only sweep
calibrationLeft[64]
calibrationRight[64]
```

Only do this if the target TV reliably exposes separate processing channels.

The current engine writes the same calibration curve across channels; preserve that as the V1 fallback.

---

# Development Logging

Add concise measurement logs, not giant PCM dumps.

Web development log should include:

```text
measurement session ID
capture settings
sweep parameters
peak/RMS/SNR
sweep detection offset
mic profile ID
overall target RMS error
LF extension
max cut/boost
headroom
```

Android log should include:

```text
measurement prepare
transient bypass active
AudioTrack format
sweep start/finish
restore success
measurement timeout/abort
```

Do not log pair secrets or microphone PCM.

---

# Tests

## Web unit tests

- [ ] mic profile frequencies strictly increasing
- [ ] mic interpolation on log-frequency axis
- [ ] mic inverse compensation sign is correct
- [ ] target interpolation
- [ ] octave smoothing
- [ ] LF extension heuristic
- [ ] null boost suppression
- [ ] max boost/cut clamping
- [ ] high-frequency trust weighting
- [ ] 64-band mapper
- [ ] protocol payload validation

Use synthetic response curves for optimizer tests.

Examples:

```text
+8 dB broad peak at 80 Hz
→ strong negative correction

-12 dB narrow notch at 130 Hz
→ ~0 dB positive correction

-6 dB broad shelf above speaker LF extension
→ limited boost <= +3 dB only with headroom

-15 dB response below natural LF extension
→ no deep-bass boost
```

## Android tests / target-TV tests

- [ ] measurement bypass does not persist
- [ ] measurement abort restores EQ
- [ ] timeout restores EQ
- [ ] sweep is audible on actual AUX/output path
- [ ] sweep is not processed by existing room/user EQ
- [ ] sample rate and channel layout reported correctly
- [ ] service remains stable after 20 repeated sweeps
- [ ] memory returns near baseline after measurements
- [ ] user EQ remains intact after calibration

## Acoustic acceptance tests

1. Fixed phone position, 3+ repeated sweeps.
2. Verify repeatability.
3. Apply a known manual test EQ on TV.
4. Re-measure and verify the measured response moves in the expected direction.
5. Generate automatic correction.
6. Apply correction.
7. Run validation sweep.
8. Confirm target error improves rather than merely predicted to improve.

---

# TODO Order

Implement in this dependency order.

- [ ] Add concrete shared measurement protocol payload types.
- [ ] Implement `MeasurementController` on Android.
- [ ] Implement non-persistent measurement bypass/restore.
- [ ] Implement deterministic 20 Hz–20 kHz exponential sweep with `AudioTrack`.
- [ ] Wire `measurement.prepare/playSweep/abort` through `SweetSpotService` + `MailboxClient`.
- [ ] Make `supportsSweep` report true only after real target-TV validation.
- [ ] Build browser mic permission/diagnostics component.
- [ ] Capture raw Float32 PCM through Web Audio / AudioWorklet.
- [ ] Build sweep reference generator using TV-returned parameters.
- [ ] Build worker-based sweep detection + deconvolution.
- [ ] Display a single raw/smoothed measured response with **no auto-EQ yet**.
- [ ] Pass the fixed-position 3-sweep repeatability gate.
- [ ] Digitize and commit the Faber iPhone 17 Pro free-field response profile.
- [ ] Add mic-profile interpolation + inverse compensation.
- [ ] Validate whether Safari capture needs an additional response delta vs SignalScope measurement mode.
- [ ] Add iPhone orientation guidance.
- [ ] Add high-frequency mic trust weighting.
- [ ] Add 5-position guided measurement flow.
- [ ] Add robust spatial aggregation + frequency spread/confidence.
- [ ] Add SweetSpot default room target.
- [ ] Add speaker LF-extension detection.
- [ ] Implement constrained target-error correction.
- [ ] Implement correct mapping to the 64 `DynamicsProcessing.EqBand` ranges.
- [ ] Add automatic headroom/preamp protection.
- [ ] Apply correction through existing `calibration.apply`.
- [ ] Add verification sweep.
- [ ] Show Before / Target / After + improvement metrics.
- [ ] Add Gentle / Normal / Strong correction strength.
- [ ] Remove/de-emphasize the manual calibration JSON textarea once the wizard is stable.
- [ ] Only then investigate independent L/R calibration.

---

# First Coding Deliverable

Do **not** begin with the optimizer.

The first PR/implementation slice should do only this:

## Android

- implement measurement session prepare/abort
- implement transient DSP bypass + exact restore
- generate and play one deterministic 8-second exponential sweep
- return sweep parameters through the existing mailbox protocol

## Web

- ask for microphone permission
- capture raw PCM
- tell TV to play one sweep
- find/analyze the sweep locally
- display one frequency-response graph

No automatic EQ in the first slice.

Definition of done:

```text
Put iPhone 17 Pro at one fixed listening position.
Run the measurement three times.
SweetSpot displays three closely matching frequency-response curves.
No microphone PCM leaves the browser.
TV DSP state is identical before and after each measurement.
```

Only after that works reliably should the Faber compensation + target optimizer be connected to the measurement result.

---

# V1 Definition of Done

SweetSpot room auto-correction V1 is complete when:

- [ ] User scans/connects to the TV from iPhone Safari.
- [ ] Hosted HTTPS dashboard obtains microphone permission.
- [ ] User selects the built-in iPhone 17 Pro Faber profile.
- [ ] Wizard instructs correct bottom-mic orientation.
- [ ] TV plays deterministic sweeps on command.
- [ ] Phone records locally and derives repeatable response measurements.
- [ ] Five nearby positions can be measured.
- [ ] iPhone mic response compensation is applied.
- [ ] SweetSpot creates a conservative in-room target.
- [ ] Broad room/speaker errors are corrected.
- [ ] Narrow/null boosts are suppressed.
- [ ] Deep bass below speaker capability is not boosted.
- [ ] High treble correction is intentionally conservative.
- [ ] Final correction is mapped to the existing 64-band TV calibration layer.
- [ ] Positive gain cannot clip because automatic headroom is enforced.
- [ ] User's 24-band EQ remains available on top of calibration.
- [ ] A post-correction sweep verifies the actual result.
- [ ] UI shows Before / Target / After.
- [ ] Calibration survives TV service restart through existing persistence.

The objective is not mathematical flatness. The objective is a **stable, audibly useful, safe correction of repeatable speaker/room behavior around the listening position**.