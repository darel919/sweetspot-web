# SweetSpot room transport

The static dashboard and room API run on one Cloudflare Worker. Room state is
owned by a Durable Object and is delivered through WebSockets.

## Roles

- `device` is the Android TV. It keeps one room WebSocket open.
- `client` is the phone or laptop dashboard. It sends commands and receives
  device messages.

## Room connection

```text
GET /api/room/{code}/ws?role=device  WebSocket
GET /api/room/{code}/ws?role=client   WebSocket
```

The pairing code is the short-lived room credential. The Worker validates its
format and routes both roles to the matching room Durable Object. Client
sockets also require an allowed browser `Origin`. The room starts a ten-minute
session on its first connection and closes all sockets when that session
expires. Every connection receives a `room.ready` frame with its `role` and
current `deviceOnline` state.

The device receives commands on its socket and sends replies on the same
socket. The dashboard sends commands on its socket and receives device
messages on that socket. OkHttp protocol pings keep the device connection
healthy. The dashboard uses the socket's open state as its connection state.

## Presence

The Durable Object derives presence from attached sockets whose
`readyState === WebSocket.OPEN`. A device connection broadcasts
`room.presence` to clients. A client connection broadcasts
`room.clientPresence` to the device.

The Durable Object does not persist presence timestamps or schedule presence
alarms. Closing the last socket for a role immediately broadcasts that role's
offline state.

## Envelope delivery

Room messages use the v1 envelope from `protocol.ts`.

```json
{ "v": 1, "id": "msg_01J...", "type": "state.get", "ts": 1787520000000, "payload": {}, "replyTo": "msg_01J..." }
```

The room validates known types, rejects session-only types, enforces the JSON
payload limit, and rate-limits each socket. Commands go directly to an open
device socket. If the device is offline, the client receives an error instead
of creating an unbounded mailbox. Device messages are broadcast only to open
client sockets. Nothing is replayed after reconnect.

Calibration PCM uses a separate binary WebSocket frame. A client frame must
contain the `SSCP` capture format, use version 1, and stay below 8 MiB. The
metadata JSON is limited to 64 KiB and contains the complete versioned
microphone profile selected on the phone. The room validates the frame and
forwards the original bytes to the device. A device-origin binary frame is
rejected.

The browser sends `calibration.capture.ready` or
`calibration.validation.capture.ready`, then uploads the binary frame. The
metadata and SHA-256 are inside that frame; a JSON metadata command is not part
of the production remote-microphone flow. The TV publishes
`calibration.capture.finished` after playback so the browser can stop recording. It publishes
`calibration.capture.uploaded` and `calibration.job.state` after it stores and
analyzes the capture. A reconnecting browser requests
`calibration.job.get` and renders the returned TV-owned view.

Delivery is at-most-once. The dashboard requests a fresh state snapshot after
it connects or the device becomes available. Calibration flows remain
user-driven and handle missing replies with their existing timeouts.

## Command replies

Unless a command starts a calibration session, the TV replies with
`state.snapshot` and sets `replyTo` to the command id. The explicit exceptions
are:

| Command family | Reply or event |
| --- | --- |
| `calibration.export` | `calibration.exported` |
| `diagnostics.effects` | `diagnostics.effects` |
| `diagnostics.deviceInfo` | `diagnostics.deviceInfo` |
| `probe.status` | `probe.status` |
| legacy diagnostic `calibrationSession.*` and `measurement.*` | diagnostic session lifecycle/events |

Every command and event still uses the shared payload validator. A message
without a validator is rejected at the room boundary.

## Lifecycle

Cloudflare may hibernate or restart the Durable Object while sockets remain
attached. Socket attachments restore the role and rate-limit identity when the
object resumes; no command or replay queue is persisted.
The browser must request a fresh state snapshot after reconnect. Safety-critical
calibration candidate and rollback state is persisted by the TV, not by this relay.

During rollback the TV publishes the candidate with `validationStatus:
"rolling_back"`. Clients must treat that state as pending recovery, disable
validation and acceptance, and continue to rely on the next TV snapshot.
