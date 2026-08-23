# SweetSpot wire protocol v1

Single source of truth for every message exchanged between the browser
dashboard (`client`) and the Android TV (`device`) through the relay.

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
- Unknown `type` values get a `session.error` reply with `code: "unknown_type"`.
- Wrong `v` gets `session.error` with `code: "version_mismatch"`.
- Payloads above `MAX_PAYLOAD_BYTES` (16 KiB) are rejected with
  `session.error` / `"payload_too_large"` and the connection is closed.
- `ping`/`pong` carry no payload.

## Session / transport

| Type | Direction | Payload |
| --- | --- | --- |
| `session.hello` | both, first message after open | `{ role: "device" \| "client", room: string }` |
| `session.welcome` | relay -> peer | `{ room, peers: { deviceOnline: boolean, clients: number } }` |
| `session.peerJoined` | relay -> peers | `{ role }` |
| `session.peerLeft` | relay -> peers | `{ role }` |
| `session.error` | relay -> peer | `{ code: string, message?: string }` |
| `ping` / `pong` | both | none |

Room naming: `pair:<normalized pair code>`. Codes normalize to uppercase with
dashes stripped so `7k4m-p2wx` and `7K4MP2WX` join one room. The relay never
validates codes against a registry; it only enforces format and isolation.

## Device state

| Type | Direction | Payload |
| --- | --- | --- |
| `state.get` | client -> device | `{}` |
| `state.snapshot` | device -> clients | see below |
| `state.changed` | device -> clients | partial snapshot fields |

Snapshot shape (canonical, no Android objects):

```jsonc
{
  "device": { "id": "tv_...", "name": "Living Room TV", "appVersion": "0.2.0" },
  "engine": { "enabled": true, "hasControl": true, "activePreset": 1, "presetName": "Flat" },
  "userEq": { "bandsDb": [], "frequenciesHz": [], "minDb": -15, "maxDb": 15 },
  "calibration": { "active": false, "bandsDb": [], "frequenciesHz": [] },
  "profiles": [],
  "capabilities": { "channels": 2, "calibrationBandCount": 64, "userBandCount": 24, "supportsSweep": true }
}
```

## Engine / profiles / calibration (routed client -> device)

`engine.enable`, `engine.bypass`, `engine.setBands`, `engine.applyPreset`,
`profile.list`, `profile.save`, `profile.load`, `profile.delete`,
`calibration.get`, `calibration.apply`, `calibration.reset`.

Device answers each with a `replyTo`-tagged response or `session.error`.
These types are declared now so the envelope validation accepts them; the
Android side implements them in later milestones.

## Measurement (later phases)

`measurement.prepare`, `measurement.ready`, `measurement.playSweep`,
`measurement.started`, `measurement.finished`, `measurement.abort`,
`measurement.error`.

## Diagnostics (dev builds only)

`diagnostics.deviceInfo`, `diagnostics.probe`. Never expose shell-like or
arbitrary command surfaces through these.
