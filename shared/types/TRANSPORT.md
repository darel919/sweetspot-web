# SweetSpot transport: WebSocket-first mailbox over Cloudflare

The SPA (static) and the room API live on one Cloudflare Worker.
Room state lives in a Durable Object, in memory only. No database.

## Roles

- `device` = the Android TV. Keeps one hibernatable WebSocket and uses HTTP
  long-polling only while an older Worker is being upgraded.
- `client` = the phone/laptop dashboard. Sends commands and receives device-originated messages.

## Pair code → room

Pair codes normalize exactly like before: strip dashes, uppercase, 6-10 chars
of `[A-Z0-9]`. Room id = normalized code. One DO instance per room via
`idFromName(code)`.

## Endpoints

All JSON. Errors: `{ "error": "reason" }` with 4xx status.

### Device

```
GET  /api/room/{code}/ws?role=device  WebSocket      -> room.ready, Envelope, or room.clientPresence
GET  /api/room/{code}/commands?wait=9 -> { commands: [Envelope,...] }
POST /api/room/{code}/device          Envelope       -> { ok: true }   // snapshot etc. to clients
POST /api/room/{code}/register        { }            -> { ok: true }   // legacy fallback only
```

The device WebSocket receives commands directly and sends replies on the same
connection. OkHttp protocol pings keep the connection healthy; the app sends no
heartbeat messages. The Durable Object can hibernate while the socket stays
connected.

The HTTP fallback uses `commands` long-polling up to `wait` seconds (default 9,
max 25). `commands` also refreshes device presence, so a separate `register`
request is unnecessary. The legacy endpoints remain during rolling upgrades.

### Client

```
GET  /api/room/{code}/state           -> { deviceOnline: bool, messages: [Envelope,...] }
POST /api/room/{code}/client          Envelope       -> { ok: true }
GET  /api/room/{code}/ws?role=client  WebSocket      -> room.ready, Envelope, or room.presence
```

The dashboard opens `/ws?role=client` first. The room sends `room.ready` with
current presence and queued device messages. It then sends each new device
Envelope immediately. Presence comes from the open socket, so the dashboard
sends no application heartbeat. During a rolling upgrade, an unlabeled legacy
`room.ready` enables a temporary compatibility heartbeat only for that old
Worker.

The dashboard falls back to `state?since=...` at a deliberately low rate when
the WebSocket cannot open.
The HTTP endpoints remain part of the transport so older browsers and device
builds keep working.

## Envelope

Unchanged protocol v1 (`shared/types/protocol.ts`): `{v,id,type,ts,payload,replyTo?}`.
Validation rules identical to the previous relay: known types only, size cap,
rate limiting per connection.

## Delivery semantics

At-most-once. A command is removed from the queue when handed to the device's
poll. A command sent through the WebSocket enters the same queue as a command
sent to `/client`. Live state snapshots are not retained for reconnect replay.
The dashboard requests a fresh snapshot after reconnect. The dashboard treats
missing `replyTo` responses as retryable. All calibration flows are user-driven,
so nothing depends on guaranteed delivery.

## Lifecycle

A room with no recent activity holds no resources: DOs hibernate between
requests and in-memory state is discarded after eviction. The WebSocket peers
can remain connected while the DO hibernates. Legacy HTTP fallback clients
re-poll automatically, so eviction is invisible except that undelivered
queued commands are dropped.
