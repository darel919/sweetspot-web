# SweetSpot transport: HTTP mailbox over Cloudflare

The SPA (static) and the room API live on one Cloudflare Worker.
Room state lives in a Durable Object, in memory only. No database.

## Roles

- `device` = the Android TV. Registers with a pair code and long-polls for commands.
- `client` = the phone/laptop dashboard. Posts commands, reads device-originated messages.

## Pair code → room

Pair codes normalize exactly like before: strip dashes, uppercase, 6-10 chars
of `[A-Z0-9]`. Room id = normalized code. One DO instance per room via
`idFromName(code)`.

## Endpoints

All JSON. Errors: `{ "error": "reason" }` with 4xx status.

### Device

```
POST /api/room/{code}/register        { }            -> { ok: true }
GET  /api/room/{code}/commands?wait=9 -> { commands: [Envelope,...] }
POST /api/room/{code}/device          Envelope       -> { ok: true }   // snapshot etc. to clients
```

`register` marks the device present. `commands` long-polls up to `wait`
seconds (default 9, max 25) and returns as soon as at least one command is
queued; returns `{commands:[]}` on timeout. The device must re-register if it
has not polled for over 15 s — clients then see it offline.

### Client

```
GET  /api/room/{code}/state           -> { deviceOnline: bool, messages: [Envelope,...] }
POST /api/room/{code}/client          Envelope       -> { ok: true }
```

`state` returns everything the device has published since the client's last
poll plus current presence. Clients poll this every 1-2 s while the page is
open; there is no persistent connection.

## Envelope

Unchanged protocol v1 (`shared/types/protocol.ts`): `{v,id,type,ts,payload,replyTo?}`.
Validation rules identical to the previous relay: known types only, size cap,
rate limiting per connection.

## Delivery semantics

At-most-once. A command is removed from the queue when handed to the device's
poll. The dashboard treats missing `replyTo` responses as retryable; all
calibration flows are user-driven, so nothing depends on guaranteed delivery.

## Lifecycle

A room with no recent activity holds no resources: DOs hibernate between
requests and in-memory state is discarded after eviction. Both peers
re-register/re-poll automatically, so eviction is invisible except that
undelivered queued commands are dropped.
