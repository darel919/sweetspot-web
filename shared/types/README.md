# SweetSpot wire protocol v1

Transport-agnostic message contract between the browser dashboard (`client`)
and the Android TV (`device`). Transport details live in
[TRANSPORT.md](./TRANSPORT.md) (WebSocket mailbox on Cloudflare).

## Envelope

```jsonc
{
  "v": 1,                      // protocol version, always 1 today
  "id": "msg_01J...",          // unique sender-generated id
  "type": "state.get",         // message type, see lists below
  "ts": 1787520000000,         // sender wall clock, informational only
  "payload": {},               // type-specific, may be empty
  "replyTo": "msg_01J..."      // set on responses/acks referencing a request id
}
```

Rules:

- Unknown optional fields must be ignored.
- Unknown `type` values are rejected by the mailbox with `unknown_type`.
- Payloads above `MAX_PAYLOAD_BYTES` (16 KiB) are rejected.
- `ping`/`pong` carry no payload. Either side may ping; the receiver must pong.
- The room transport has no `room.ping` control frame.

## Message types

Session-scoped types (`session.hello`, `session.welcome`, `session.peerJoined/Left`,
`session.error`) are not routed. Room WebSocket presence uses `room.ready`,
`room.presence`, and `room.clientPresence` control frames. Every `room.ready`
frame includes the connected socket's `role`.

Device-targeted (client -> device): `state.get`, `engine.enable`,
`engine.bypass`, `engine.setBands`, `engine.applyPreset`, `profile.list`,
`profile.save`, `profile.load`, `profile.delete`, `calibration.get`,
`calibration.applyCandidate`, `calibration.acceptCandidate`,
`calibration.rollbackCandidate`, `calibration.validation.result`,
`calibration.reset`, `calibration.export`, `calibration.import`,
`calibrationSession.begin`,
`calibrationSession.end`, `calibrationSession.abort`,
`calibrationSession.loudness.start`, `calibrationSession.loudness.stop`,
`calibrationSession.progress`, `measurement.prepare`,
`measurement.playSweep`, `measurement.abort`, `measurement.diagnostics`.

Device-published (device -> clients): `state.snapshot`, `state.changed`,
`calibrationSession.started`, `calibrationSession.ended`,
`calibrationSession.loudness.started`, `calibrationSession.loudness.stopped`,
`calibrationSession.position.continued`,
`measurement.ready`, `measurement.started`, `measurement.finished`,
`measurement.error`, `calibration.exported`.

`calibration.export` returns the active final EQ curve as a versioned
`sweetspot.calibration` package. The package contains the TV frequency grid,
the requested curve, optional effective DSP readback, and source-device
metadata. It does not contain microphone PCM or room-measurement checkpoints.

`calibration.import` accepts an active package on the TV's frequency grid. The
TV applies and verifies the curve, then stores it as a candidate with
`validationStatus: "imported"`. The client must accept or roll back that
candidate. Imported data is not presented as an acoustic validation result.

Diagnostics (dev builds only): `diagnostics.deviceInfo`, `diagnostics.probe`,
`diagnostics.effects`, `probe.run`, `probe.status`,
`probe.persistent.start`, `probe.persistent.release`, and
`probe.curve.apply`. The persistent probe is a temporary 64-band overlay on
the production session-0 DynamicsProcessing effect; it is not a second global
effect and it is never persisted. `probe.curve.apply` accepts either a named
diagnostic curve or `bandsDb` with optional paired `leftBandsDb` and
`rightBandsDb` arrays. The browser's routing lab uses one microphone and
repeated left/right physical positions; exported captures remain diagnostic
evidence until the real-device transfer and routing gates are explicitly
reviewed.

## State snapshot

Canonical shape in `protocol.ts` (`StateSnapshot`). The TV answers
`state.get` with a `state.snapshot` carrying `replyTo`.

When `calibration.transaction.state` is `candidate_pending`, `previousActive`
describes whether calibration was active in the TV's live DSP state immediately
before the candidate was staged. It is the rollback target summary. Browser
measurement checkpoints and generated-but-uncommitted corrections are not
calibration transactions and must never be used as rollback state.
