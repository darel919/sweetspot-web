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

The Worker validates the pair code, routes the request to the room Durable
Object, and forwards the WebSocket upgrade. Every connection receives a
`room.ready` frame with its `role`, current `deviceOnline` state, and queued
messages for that role.

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

The room validates known types, rejects session-only types, enforces the
payload limit, and rate-limits each socket. Commands go directly to an open
device socket or stay in the room's bounded in-memory queue until the device
connects. Queued commands carry a short expiry and are discarded after it.
Device messages are broadcast to open client sockets and retained in the same
bounded in-memory replay queue for the next client connection. State snapshots
are not replayed.

Delivery is at-most-once. The dashboard requests a fresh state snapshot after
it connects or the device becomes available. Calibration flows remain
user-driven and handle missing replies with their existing timeouts.

## Lifecycle

Cloudflare may hibernate or restart the Durable Object while sockets remain
attached. Socket attachments restore the role and connection identity when the
object resumes, but the in-memory command and replay queues are not durable.
The browser must request a fresh state snapshot after reconnect. Safety-critical
calibration candidate and rollback state is persisted by the TV, not by this
transport queue.

During rollback the TV publishes the candidate with `validationStatus:
"rolling_back"`. Clients must treat that state as pending recovery, disable
validation and acceptance, and continue to rely on the next TV snapshot.
