# SweetSpot Web Dashboard + Device Relay + Auto-Correction Implementation Plan

## Purpose

This document is the implementation brief for the next development phase of SweetSpot.

There are two repositories:

- Android TV / DSP / device agent: `https://github.com/darel919/SweetSpot`
- Web dashboard / calibration client / relay: `https://github.com/darel919/sweetspot-web`

Production web target:

- `https://sweetspot.darelisme.my.id`

The web project already exists. **Do not recreate or re-scaffold the Nuxt project.** Work from the current repository.

The current web app is a Nuxt SPA (`ssr: false`). Preserve that architecture. Browser-only features such as microphone capture, Web Audio processing, calibration analysis, and graphs belong on the client.

The Android TV must remain lightweight and continue to own only device-local responsibilities: global audio DSP, persistent profiles/calibration, test-signal playback, pairing identity, and network/device communication.

---

# 1. Final Product Architecture

```text
┌─────────────────────────────────┐
│ iPhone / laptop browser         │
│ sweetspot.darelisme.my.id       │
│                                 │
│ Nuxt SPA                        │
│ - dashboard                     │
│ - microphone capture            │
│ - measurement analysis          │
│ - correction optimizer          │
│ - graphs                        │
└───────────────┬─────────────────┘
                │ HTTPS / WSS
                ▼
┌─────────────────────────────────┐
│ SweetSpot Web / Vercel          │
│                                 │
│ - pairing/session rooms         │
│ - WebSocket relay               │
│ - static Nuxt app               │
│                                 │
│ NO raw microphone audio storage │
│ NO room-correction DSP          │
└───────────────┬─────────────────┘
                │ outbound WSS
                ▼
┌─────────────────────────────────┐
│ Android TV                      │
│ SweetSpot                       │
│                                 │
│ - global DynamicsProcessing     │
│ - 64-band calibration EQ        │
│ - 24-band user EQ               │
│ - profiles                      │
│ - sweep/test signal playback    │
│ - device agent                  │
└─────────────────────────────────┘
```

Optional fast path later:

```text
browser ── local LAN HTTP ──> TV
```

The local path is an optimization only. The product must work without it because browser Local Network Access support, especially on Safari, must not be treated as universally available.

---

# 2. Design Principles

1. **Relay first, LAN second.**
   The reliable transport is WSS through the hosted SweetSpot service. Direct LAN may be attempted later when supported.

2. **No raw microphone audio in the cloud.**
   Recording and measurement analysis happen inside the browser. Only commands, state, compact measurement metadata, and final correction values are sent over the relay.

3. **TV initiates outbound connectivity.**
   Never expose the Android TV directly to the public Internet.

4. **Keep TV resource usage small.**
   No large UI frameworks, no heavy DSP libraries, no cloud SDK unless justified. The existing native Kotlin architecture should remain lightweight.

5. **One shared wire protocol.**
   Define message names and payloads before implementing features. Do not allow the web and Android implementations to invent separate schemas.

6. **Calibration and user EQ remain separate.**

```text
effective EQ = room calibration + user adjustment
```

The current Android architecture already follows this concept. Preserve it.

7. **Implement and verify one milestone before moving to the next.**
   Do not build the optimizer before microphone capture, sweep playback, transport, and repeatable measurement are proven independently.

---

# 3. Repository Responsibilities

## `darel919/SweetSpot`

Owns:

- `SweetSpotService`
- `DynamicsProcessingEq`
- global audio session 0
- calibration bands
- user EQ bands
- persistent profiles
- device identity
- pairing state shown on TV
- outbound relay WebSocket client
- local REST API for debugging and optional LAN mode
- sweep / test signal generation
- commands that directly affect TV audio

The Android app should eventually stop serving the full browser dashboard from `app/src/main/assets/www`.

Do **not** remove the old embedded dashboard immediately. Keep it during migration until the hosted web app reaches feature parity and the relay path is proven.

## `darel919/sweetspot-web`

Owns:

- hosted dashboard
- connection UI
- QR/pair-code parsing
- relay WebSocket client
- TV state model
- EQ/profile controls
- browser microphone permission
- recording
- Web Audio processing
- sweep deconvolution / frequency-response estimation
- microphone compensation
- multipoint aggregation
- target curve
- safe correction generation
- before/after visualization

---

# 4. Connection Model

## Normal UX

```text
1. User opens SweetSpot on TV.
2. TV connects to SweetSpot relay over WSS.
3. TV displays a QR code and short pairing code.
4. User scans QR with iPhone.
5. Safari opens:
   https://sweetspot.darelisme.my.id/connect/<pair-code>
6. Browser joins the same relay room.
7. Relay announces that the TV and dashboard are paired.
8. Dashboard requests current TV state.
9. User controls the TV and can start calibration.
```

Manual connection can exist as a development/fallback mode, but normal users should not need to type an IP address.

---

# 5. Device Identity and Pairing

Create a persistent random device ID on Android on first run.

Example:

```text
deviceId = tv_4a61e8f1b90c
```

Do not use MAC address, serial number, Android ID, or another hardware identifier as the public device identity.

Generate a short-lived pairing secret when the TV service starts or when the user requests a new pair code.

Example:

```text
pairCode = 7K4M-P2WX
```

Suggested characteristics:

- random, not sequential
- 8-10 readable characters
- case-insensitive alphabet if possible
- expires after approximately 10 minutes when unused
- can be regenerated on TV
- not sufficient by itself for permanent remote control after pairing expires

QR target:

```text
https://sweetspot.darelisme.my.id/connect/7K4M-P2WX
```

The QR should not need the local TV IP to function.

The TV may advertise its local URL separately for optional LAN debugging:

```text
http://192.168.1.47:8080
```

---

# 6. WebSocket Relay

Use one WebSocket endpoint in the Nuxt project, preferably:

```text
/api/ws
```

Follow the current official Vercel/Nitro WebSocket approach using Nitro/crossws and room/topic pub-sub where supported by the installed Nuxt/Nitro version.

The current repository uses Nuxt 4.x. Do not upgrade blindly. First determine whether its installed Nitro version supports the required Vercel WebSocket adapter. If not, upgrade the minimum necessary Nuxt/Nitro packages while preserving the existing SPA application.

Enable WebSocket support in `nuxt.config.ts` only using the currently supported Nuxt/Nitro configuration.

The relay is deliberately dumb. It should validate envelopes, isolate rooms, and forward messages. It must not know how room correction works.

## WebSocket roles

Every connection identifies itself as one of:

```text
device
client
```

- `device` = Android TV
- `client` = browser dashboard

A room should normally contain one device and one or more authorized clients.

## Heartbeat

Implement application-level ping/pong plus reconnect behavior.

Suggested values:

```text
heartbeat interval: 20-30 s
missed heartbeats before reconnect: 2
reconnect: exponential backoff with jitter
```

Both TV and browser must recover automatically after:

- Wi-Fi interruption
- Vercel function recycle / maximum duration
- browser background/foreground cycle
- TV network change

After reconnect, request a fresh complete state snapshot. Do not assume state remained synchronized.

---

# 7. Shared Wire Protocol

Use JSON for V1. Payload volume is tiny and debuggability is more valuable than binary optimization.

Every message uses a common envelope:

```json
{
  "v": 1,
  "id": "msg_01J...",
  "type": "state.get",
  "ts": 1787520000000,
  "payload": {}
}
```

Fields:

- `v`: protocol version
- `id`: unique message/request ID
- `type`: message type
- `ts`: sender timestamp in milliseconds; informational only, never use for acoustic synchronization
- `payload`: type-specific object

Responses to requests should include:

```json
{
  "v": 1,
  "id": "msg_02J...",
  "replyTo": "msg_01J...",
  "type": "state.snapshot",
  "ts": 1787520000100,
  "payload": {}
}
```

## Initial message types

### Session / transport

```text
session.hello
session.welcome
session.peerJoined
session.peerLeft
session.error
ping
pong
```

### Device state

```text
state.get
state.snapshot
state.changed
```

### Engine

```text
engine.enable
engine.bypass
engine.setBands
engine.applyPreset
```

### Profiles

```text
profile.list
profile.save
profile.load
profile.delete
```

### Calibration curve

```text
calibration.get
calibration.apply
calibration.reset
```

### Measurement

```text
measurement.prepare
measurement.ready
measurement.playSweep
measurement.started
measurement.finished
measurement.abort
measurement.error
```

### Diagnostics

Keep development-only messages separate, e.g.:

```text
diagnostics.deviceInfo
diagnostics.probe
```

Do not expose arbitrary Android commands or shell-like behavior through the relay.

---

# 8. State Snapshot Contract

Create one canonical state representation used by the hosted dashboard.

Example shape:

```json
{
  "device": {
    "id": "tv_4a61e8f1b90c",
    "name": "Living Room TV",
    "appVersion": "0.2.0",
    "online": true
  },
  "engine": {
    "enabled": true,
    "hasControl": true,
    "activePreset": 1,
    "presetName": "Flat"
  },
  "userEq": {
    "bandsDb": [0, 0, 0],
    "frequenciesHz": [20, 27, 36],
    "minDb": -15,
    "maxDb": 15
  },
  "calibration": {
    "active": false,
    "bandsDb": [],
    "frequenciesHz": []
  },
  "profiles": [],
  "capabilities": {
    "channels": 2,
    "calibrationBandCount": 64,
    "userBandCount": 24,
    "supportsSweep": true
  }
}
```

Do not leak implementation-specific Android objects into the web schema.

---

# 9. Phase 1 — Prove Hosted WebSocket Transport

Goal: browser and TV can exchange commands through Vercel without calibration features.

## Web work

Create approximately:

```text
shared/
  types/protocol.ts

server/
  api/ws.ts

app/
  composables/useSweetSpotConnection.ts
  pages/index.vue
  pages/connect/[code].vue
```

Exact names may vary if there is a better Nuxt convention, but keep protocol types centralized.

Implement:

- WebSocket connect
- role/room identification
- ping/pong
- automatic reconnect
- connection status
- raw debug event log in development mode

Create a minimal temporary UI showing:

```text
Disconnected / Connecting / Connected
Pair code
Device online/offline
Last message
```

## Android work

Add a small outbound WebSocket device client owned by `SweetSpotService`.

Responsibilities:

- connect to the production relay URL
- identify device
- join pair room
- reconnect automatically
- deserialize protocol messages
- route valid commands to the service/audio engine
- send acknowledgements/state snapshots

Do not put WebSocket networking into `DynamicsProcessingEq`.

## Acceptance criteria

- browser connects to `/api/ws`
- TV connects outbound to `/api/ws`
- both join the same room
- browser requests `state.get`
- TV returns `state.snapshot`
- TV remains controllable after one forced WebSocket disconnect/reconnect

Do not proceed until this is stable.

---

# 10. Phase 2 — Pairing UX

Goal: scanning the TV QR opens the correct dashboard session automatically.

Implement on TV:

- persistent random `deviceId`
- rotating short-lived `pairCode`
- QR code containing hosted `/connect/<pairCode>` URL
- text fallback pair code
- connection status: offline / waiting / paired

Implement on web:

- `/connect/[code]`
- validate code format
- connect immediately
- clear connection state when code is expired/invalid
- persist a successful paired device locally in browser storage only if safe

For V1, permanent accounts are not required.

Do not build user authentication until there is a concrete need for remote multi-user management.

---

# 11. Phase 3 — Migrate Existing Dashboard Features

Goal: hosted dashboard reaches parity with the existing TV-served web UI.

Port functionality, not old implementation style.

Hosted dashboard must support:

- engine enable/bypass
- 24 user EQ bands
- current values and frequencies
- presets
- save/load/delete profiles
- calibration state
- reset calibration
- device diagnostics useful during development

Create composables/services rather than putting all request logic inside a single page component.

Suggested structure:

```text
app/
  components/
    connection/
    eq/
    profiles/
    calibration/
    diagnostics/
  composables/
    useSweetSpotConnection.ts
    useSweetSpotDevice.ts
    useSweetSpotEq.ts
  pages/
    index.vue
    connect/[code].vue

shared/
  types/
    protocol.ts
    device.ts
```

Once hosted feature parity is verified, the Android `assets/www` dashboard can be reduced or removed in a later cleanup commit.

Keep the local REST API because it is useful for:

- ADB-free debugging
- optional direct-LAN transport later
- development recovery if relay is unavailable

---

# 12. Phase 4 — Secure Browser Microphone Capture

Goal: prove clean microphone recording on iPhone Safari from the hosted HTTPS site.

Use `navigator.mediaDevices.getUserMedia()` only from explicit user interaction.

Request constraints similar to:

```js
{
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  }
}
```

Then inspect actual track settings. Do not assume Safari honored every constraint.

Create a microphone diagnostics screen showing:

- permission state
- selected input label when available
- actual sample rate
- actual channel count
- supported constraints
- actual track settings
- live RMS level
- clipping indicator

Do not start room correction yet.

Acceptance criteria:

- works on target iPhone Safari over `https://sweetspot.darelisme.my.id`
- can record at least 15 seconds continuously
- no unexpected AGC pumping visible during a controlled test when disable flags are supported
- waveform/sample buffer can be passed to an analysis worker

---

# 13. Phase 5 — TV Sweep Generator

Goal: TV can generate a deterministic calibration signal on command.

Implement test-signal playback on Android, preferably with `AudioTrack` and generated PCM rather than shipping large audio files.

Initial sweep:

```text
exponential/log sine sweep
20 Hz -> 20 kHz
approximately 8 seconds
```

Include:

```text
~1 s silence before
sweep
~1 s silence after
```

Parameters must be deterministic and included in `measurement.started` so the browser knows exactly what reference signal was used.

Example:

```json
{
  "sampleRate": 48000,
  "startHz": 20,
  "endHz": 20000,
  "durationMs": 8000,
  "channel": "both",
  "levelDb": -12
}
```

Do not synchronize phone and TV clocks.

The phone starts recording first, asks TV to play, and finds the sweep acoustically in the captured recording.

During measurement, temporarily bypass user EQ and existing calibration so the system measures the untreated speaker/room response.

Restore previous state after measurement finishes or aborts, including after exceptions.

---

# 14. Phase 6 — Measurement Analysis

Goal: produce a stable frequency-response curve from one sweep.

Run heavy browser DSP outside the Vue render thread.

Prefer:

```text
Web Worker
```

Potential pipeline:

```text
recorded PCM
    ↓
find sweep / trim recording
    ↓
deconvolution against known sweep
    ↓
impulse response
    ↓
windowing
    ↓
FFT
    ↓
magnitude response
    ↓
mic compensation
    ↓
frequency smoothing
```

V1 needs magnitude response only.

Do not implement phase correction or FIR convolution.

Store analysis data in browser memory during calibration. Persist only compact results if needed.

## Repeatability gate

Before building automatic correction:

1. Keep phone physically fixed.
2. Run at least three sweeps.
3. Compare resulting curves.

Target repeatability through the useful response range should be roughly within ±1 dB after smoothing, excluding obvious environmental noise or extreme LF limitations.

If measurements are not repeatable, fix capture/sweep/deconvolution first.

---

# 15. Phase 7 — Microphone Compensation

Create a microphone calibration abstraction.

```ts
interface MicCalibrationProfile {
  id: string
  name: string
  points: Array<{ frequencyHz: number; correctionDb: number }>
}
```

Support in stages:

1. generic / no compensation
2. built-in known phone profile
3. imported calibration data

Do not hardcode compensation directly into the FFT implementation.

Apply compensation through logarithmic interpolation between calibration points.

---

# 16. Phase 8 — Multi-Position Measurement

Standard calibration should support approximately five positions near the main listening position.

Concept:

```text
             position 4

position 2   position 1   position 3

             position 5
```

Offsets should be approximately 20-30 cm, not measurements throughout the entire room.

Store each measurement independently.

Compute:

- combined response
- per-frequency spread/variance
- center measurement
- confidence estimate

Do not discard the individual measurements after averaging.

A feature visible at every position is a strong correction candidate.

A deep narrow dip that only exists at one position is likely a spatial null and should usually not be boosted.

---

# 17. Phase 9 — Target Curve

Do not use a Harman headphone target directly.

Create a SweetSpot in-room speaker target with adjustable parameters.

Initial defaults can be approximately:

```text
low-frequency shelf / bass rise: +3 dB
midrange reference: 0 dB
gentle downward high-frequency tilt
```

Expose simple future controls such as:

```text
Bass
Warmth
Tilt
```

Internally represent the target as a frequency-response function sampled at the same analysis points as the measured response.

The target must respect speaker capability.

If the measured speaker naturally rolls off sharply below a detected LF extension point, the target must roll off too. Do not ask a small speaker for +10 to +20 dB of deep-bass boost.

---

# 18. Phase 10 — Safe Correction Algorithm

The Android production engine currently exposes a 64-band calibration layer. Optimize directly for those bands.

Do not port a PEQ/Q optimizer unless the Android DSP changes to actual parametric filters later.

Concept:

```text
measured response
    ↓
spatial aggregation
    ↓
target - measured
    ↓
confidence weighting
    ↓
smoothing
    ↓
boost/cut constraints
    ↓
map to 64 calibration bands
    ↓
apply on TV
```

Initial safety limits:

```text
maximum calibration cut: about -9 dB
maximum calibration boost: about +3 dB
```

Rules:

- prefer cuts over boosts
- aggressively correct broad, repeatable bass peaks
- avoid boosting deep narrow nulls
- do not boost below detected speaker extension
- high-frequency correction should be broad and conservative
- reduce correction strength when spatial variance is high
- optionally limit correction above ~10 kHz to very broad trends only

Useful conceptual correction strength by range:

```text
20-200 Hz: strongest
200 Hz-1 kHz: moderate
1-10 kHz: gentle / broad
10-20 kHz: very conservative
```

All algorithm constants must be centralized/configurable for testing rather than scattered as magic numbers.

---

# 19. Phase 11 — Per-Channel Calibration

The current Android calibration curve is effectively common to all processed channels.

After single-curve calibration is stable, add independent left/right calibration if the target TV exposes independent channels reliably.

Desired representation:

```text
calibrationLeft[64]
calibrationRight[64]
```

Measurement flow:

```text
left-only sweep
right-only sweep
```

The sweep generator must be able to mute the opposite channel during each measurement.

Keep a mono/common calibration fallback for devices where independent stereo processing is unavailable or unreliable.

Do not make per-channel support a prerequisite for the first working auto-calibration.

---

# 20. Phase 12 — Headroom / Clipping Protection

Automatic positive EQ requires headroom management.

Compute maximum effective boost after combining calibration and user EQ.

Concept:

```text
maxBoost = max(calibration + userEq)
preamp = -(maxBoost + safetyMargin)
```

Example:

```text
max effective boost = +3.0 dB
safety margin       = 0.5 dB
input gain          = -3.5 dB
```

Use `DynamicsProcessing` input gain if reliable on the target TV.

If input-gain control is not reliable, constrain calibration generation to avoid positive headroom requirements rather than silently clipping.

Headroom state should be visible in diagnostics.

---

# 21. Phase 13 — Validation Measurement

After applying generated correction:

```text
measure untreated response
        ↓
calculate correction
        ↓
apply correction
        ↓
measure again
        ↓
show before / target / after
```

Do not claim successful calibration solely because the predicted curve looks correct.

Use the validation pass to detect:

- wrong DSP band mapping
- overly aggressive boost
- ineffective correction
- changed volume
- clipping
- unexpected speaker/DSP behavior

The final calibration screen should show at minimum:

- Before
- Target
- After
- correction curve
- maximum boost/cut
- headroom/preamp adjustment

---

# 22. Optional Direct-LAN Transport

Only add this after relay mode is production-ready.

Create a transport abstraction in the web app:

```ts
interface SweetSpotTransport {
  connect(): Promise<void>
  disconnect(): void
  send(message: ClientMessage): Promise<void>
  onMessage(handler: (message: ServerMessage) => void): () => void
}
```

Implement:

```text
RelayTransport
LocalTransport
```

Connection selection can eventually be:

```text
1. known paired TV
2. try direct LAN if browser/platform permits
3. if successful, use LAN
4. otherwise silently use relay
```

The UI should show only a useful connection status, not force normal users to understand transport details.

For direct LAN mode the Android REST server will need correct CORS/preflight behavior for the hosted origin.

Do not weaken CORS to `*` for mutation APIs in production if credentials/device secrets are involved.

---

# 23. Security Requirements

The relay connects to something that controls physical audio equipment, so basic protocol security is mandatory even for V1.

Implement:

- unguessable device IDs
- short-lived pair codes
- room isolation
- payload schema validation
- message-size limits
- rate limits for abusive command bursts
- reject unknown message types
- reject wrong protocol versions cleanly
- do not expose diagnostics that can execute arbitrary code/commands
- do not log pairing secrets in production
- do not store microphone PCM server-side

Pairing should eventually exchange a longer-lived random authorization token stored on the TV and browser after successful pairing, rather than using the short pair code forever.

Design the protocol so this can be added without breaking version 1 messages.

---

# 24. Error and Recovery Behavior

The calibration process must be transactional.

Before measurement, capture the previous TV audio state:

- engine enabled/bypassed
- user EQ
- calibration EQ
- relevant channel state
- input gain/preamp

If calibration is cancelled, browser disconnects, playback fails, or an exception occurs:

```text
restore previous TV state
```

Add a measurement-session timeout on the Android side so the TV cannot remain in temporary measurement/bypass mode forever if the browser disappears.

Suggested timeout: approximately 30-60 seconds after the last active measurement command, depending on sweep duration.

---

# 25. Versioning

Protocol version starts at:

```text
v = 1
```

Android and web clients must exchange capabilities during `session.hello`/`state.snapshot`.

Never assume all installed TVs update at the same time as the website.

The hosted web app can deploy instantly while Android APKs may be older.

Therefore:

- unknown optional fields must be ignored
- required unsupported commands must return a structured error
- breaking protocol changes require a new protocol version or capability flag

---

# 26. Testing Strategy

## Protocol tests

Test encode/decode for every message type.

Test:

- malformed JSON
- unknown type
- wrong version
- missing fields
- oversized payload
- duplicate request ID

## Relay tests

At minimum simulate:

- one TV + one browser
- one TV + two browser tabs
- browser reconnect
- TV reconnect
- peer disappearance
- room isolation between two pair codes

## Android tests

Verify on actual target TCL TV:

- reconnect over Wi-Fi
- background service survival
- relay idle CPU/RAM overhead
- EQ changes via relay
- measurement state restoration
- sweep playback
- no lasting DSP corruption after aborted calibration

## iPhone Safari tests

Verify:

- microphone permission
- recording while screen remains active
- handling browser tab background/foreground
- WebSocket reconnect
- 5 sequential measurements
- no memory growth across repeated calibrations

## Acoustic repeatability tests

Before auto-EQ acceptance:

- same phone position, 3+ sweeps
- compare smoothed curves
- move phone 20-30 cm and confirm expected spatial differences
- apply a known test EQ and verify measured response changes accordingly

---

# 27. Performance Budgets

TV side should keep relay idle overhead extremely small.

Avoid:

- polling every second when WebSocket events can push changes
- large JSON payloads repeatedly
- allocating large audio buffers except during active sweep playback
- keeping measurement-only components alive when calibration is idle

Browser can do heavier processing, but FFT/deconvolution should remain in a worker to keep UI responsive.

Do not upload PCM recordings to Vercel.

---

# 28. Recommended Implementation Order

Implement in exactly this dependency order unless a concrete blocker requires adjustment:

```text
1. shared protocol definitions
2. Vercel/Nitro WebSocket relay proof
3. Android outbound WebSocket client
4. state.get / state.snapshot round trip
5. reconnect + heartbeat
6. QR/pair-code flow
7. hosted dashboard parity with current TV UI
8. microphone diagnostics
9. deterministic TV sweep playback
10. one-position measurement response
11. repeatability validation
12. mic compensation
13. multi-position measurement
14. target curve
15. constrained 64-band correction
16. headroom management
17. post-correction validation
18. optional per-channel calibration
19. optional direct-LAN transport
20. remove/reduce legacy TV-hosted dashboard
```

Do not skip directly to step 15.

---

# 29. First Concrete Coding Milestone

The first implementation PR should be intentionally small.

## `sweetspot-web`

Implement only:

- shared protocol types
- `/api/ws`
- a basic connection composable
- `/connect/[code]`
- a debug page/status panel
- heartbeat/reconnect

## `SweetSpot`

Implement only:

- device identity
- outbound WebSocket connection
- pair-code room join
- `state.get`
- `state.snapshot`
- reconnect

Do not migrate EQ controls or build calibration in this first milestone.

### Definition of done

From an iPhone browser at:

```text
https://sweetspot.darelisme.my.id/connect/<code>
```

the dashboard can connect through Vercel to the TCL Android TV and display a real state snapshot returned by the TV.

Then force-disconnect either peer and confirm it reconnects and restores state automatically.

Only after this succeeds should the next milestone begin.

---

# 30. Important Existing Android Details

Before changing the Android project, inspect current source rather than relying on old README descriptions.

The current project already includes, among other components:

```text
AudioEngine.kt
DynamicsProcessingEq.kt
SweetSpotService.kt
WebServer.kt
ProfileStore.kt
assets/www/
```

The current production DSP already has:

- 64 internal calibration bands
- 24 user-facing bands
- calibration persistence
- a global session-0 `DynamicsProcessing` engine
- an embedded local HTTP API

Preserve these capabilities while adding the remote transport.

There are some stale comments/docs referring to 128 calibration bands. Normalize those to the actual 64-band production design when touching the relevant files.

---

# 31. Non-Goals for V1

Do not implement these until the core calibration pipeline works:

- user accounts
- social/device sharing
- remote TV control from outside the intended pairing workflow
- cloud microphone recording storage
- cloud FFT processing
- FIR filters
- mixed-phase correction
- impulse-response phase correction
- automatic speaker identification
- surround-speaker calibration
- subwoofer crossover optimization
- custom Android/iOS native phone app
- mandatory direct LAN communication

The first goal is a dependable, low-resource, browser-driven room/speaker calibration system for the existing Android TV DSP.
