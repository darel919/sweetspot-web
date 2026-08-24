# SweetSpot wire protocol v1

Transport-agnostic message contract between the browser dashboard (`client`)
and the Android TV (`device`). Transport details live in
[TRANSPORT.md](./TRANSPORT.md) (WebSocket-first mailbox on Cloudflare).

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

## Message types

Session-scoped types (`session.hello`, `session.welcome`, `session.peerJoined/Left`,
`session.error`) are not routed. Room WebSocket presence uses `room.ready` and
`room.presence` control frames.

Device-targeted (client -> device): `state.get`, `engine.enable`,
`engine.bypass`, `engine.setBands`, `engine.applyPreset`, `profile.list`,
`profile.save`, `profile.load`, `profile.delete`, `calibration.get`,
`calibration.apply`, `calibration.reset`, `calibrationSession.begin`,
`calibrationSession.end`, `calibrationSession.abort`,
`calibrationSession.loudness.start`, `calibrationSession.loudness.stop`,
`calibrationSession.progress`, `measurement.prepare`,
`measurement.playSweep`, `measurement.abort`, `measurement.diagnostics`.

Device-published (device -> clients): `state.snapshot`, `state.changed`,
`calibrationSession.started`, `calibrationSession.ended`,
`calibrationSession.loudness.started`, `calibrationSession.loudness.stopped`,
`measurement.ready`, `measurement.started`, `measurement.finished`,
`measurement.error`.

Diagnostics (dev builds only): `diagnostics.deviceInfo`, `diagnostics.probe`.

## State snapshot

Canonical shape in `protocol.ts` (`StateSnapshot`). The TV answers
`state.get` with a `state.snapshot` carrying `replyTo`.
