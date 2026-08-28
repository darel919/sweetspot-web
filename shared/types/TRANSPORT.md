# SweetSpot direct transport

Production runtime communication is direct WebRTC DataChannel traffic between the Android TV and the phone or laptop dashboard. Cloudflare hosts the HTTPS dashboard and provides short-lived signaling rendezvous. It is not an application mailbox and does not carry active EQ, state, command, calibration, or PCM traffic.

## Pairing and signaling

The TV displays a QR URL containing:

- a short display code for human context;
- a cryptographically random rendezvous ID;
- a cryptographically random pair secret in the URL fragment.

The browser sends the secret only when opening the signaling WebSocket. The Worker hashes it before storing it, binds both roles to the same rendezvous, permits one client and one device, validates the browser origin, and forwards only versioned SDP and ICE messages.

The signaling endpoint is:

```text
GET /api/signaling/{rendezvousId}/ws?role=client&secret={pairSecret}
GET /api/signaling/{rendezvousId}/ws?role=device&secret={pairSecret}
```

Signaling credentials expire if they are unused for the pairing window. After the peers authenticate and complete DataChannel setup, expiry or signaling disconnection does not end the direct session. Signaling may be reacquired only when an ICE restart needs it. The browser keeps its tab generation stable across a reload of the same pairing link, while a full re-pair creates a new generation. The active peer is fenced by that unique generation/session ID, so a second client cannot silently replace it.

The Worker forwards these message kinds only:

```text
signal.hello
signal.ready
signal.peer
signal.offer
signal.answer
signal.ice
signal.complete
signal.error
```

It rejects application envelopes and binary data. Its Durable Object is a disposable rendezvous coordinator, not calibration state or a runtime relay.

## DataChannels

The browser creates two ordered, reliable channels. The TV accepts only the same labels and closes unknown channels.

### `control`

Text JSON carries the v1 application envelope and the `sweetspot.transport` capability handshake. It carries commands, request/reply messages, TV state, calibration job state and actions, diagnostics, cancellation, and application ping/RTT probes. Control has its own event path and is never queued behind PCM.

### `capture`

Binary frames carry only the capture stream. The browser honors `bufferedAmount` and `bufferedamountlow` with a bounded queue. The initial limits are 16 KiB PCM chunks and 32 KiB complete frames. A slow receiver rejects or pauses bounded work rather than accumulating a whole recording in memory.

## Capability handshake

After `control` opens, both peers exchange a `sweetspot.transport` message containing:

```text
protocolVersion
transportVersion
captureStreamVersion
buildId
channels: ["control", "capture"]
maxCaptureChunkBytes
sessionId
```

The peers enter `direct` only after both channels are open and the versions and channel contract match. Incompatible versions produce a clear protocol error. Optional capabilities may be added only with an explicit compatibility rule.

## Capture stream format

Every frame starts with a 16-byte big-endian header:

```text
bytes 0..3   ASCII SSCS
bytes 4..5   uint16 stream version, currently 1
byte 6       kind: 1 begin, 2 chunk, 3 end
byte 7       reserved, must be zero
bytes 8..11  uint32 JSON header length
bytes 12..15 uint32 PCM payload length
```

The JSON header is UTF-8. Begin and end frames have no payload. Chunk payloads are little-endian Float32 mono PCM and must be non-empty, Float32 aligned, and no larger than 16 KiB. Complete frames must be no larger than 32 KiB.

Begin headers identify `sessionId`, `captureId`, metadata, and optional expected sample and byte counts. End headers identify the same capture and contain chunk count, final sample count, final byte count, final SHA-256, and complete capture metadata. The metadata capture ID, counts, and content hash must agree with the frame header and end values.

The Android receiver writes chunks to a bounded `.partial` file, requires contiguous sequence numbers, accepts an exact duplicate idempotently, rejects conflicting duplicates and gaps, updates SHA-256/sample/byte counts incrementally, and atomically renames the file only after all checks pass. Orphan partial and ready files are removed on recovery. A finalized file is passed to the TV calibration engine and deleted after the engine has persisted or rejected the capture.

## Reconnect and fencing

Application state is owned by the TV, not by browser presence. The direct transport exposes `idle`, `pairing`, `signaling`, `connecting`, `direct`, `reconnecting`, `failed`, and `closed` states.

- A transient peer disconnect enters a grace period and does not cancel a TV-owned job.
- A failed peer may perform an ICE restart through fresh signaling.
- A browser reload restores the pairing link's tab generation, reconnects, and requests current TV state and job state.
- A service restart restores persisted TV state and creates a fresh pairing session.
- A broken capture stream is rejected and may retry the same TV-issued action; prior accepted evidence remains.
- Old callbacks, envelopes, candidates, and capture frames cannot mutate a newer session.
- Pair-code rotation never kills an already authenticated direct session.

Normal UI reduces diagnostics to `Connected directly`, `Reconnecting…`, `TV offline`, or an actionable direct-path error. Developer diagnostics may include ICE state, candidate classification, RTT, bytes, buffered capture bytes, reconnect count, signaling round trip, and capture progress. Never log pair secrets or other authentication material.

The `diagnostics.transport` control request exposes the TV's bounded peer snapshot to the dashboard's developer details. The TV redacts the session generation to its final eight characters and includes the selected candidate type, protocol, and RTT when the native WebRTC stats report them; unavailable values remain `null`.

## Cloud-independence invariant

After both DataChannels open, block the Worker and the public Internet while preserving local Wi-Fi. Commands, state, EQ changes, cancellation, PCM transfer, analysis, and calibration completion must continue over the direct peer. If that test fails, the implementation still has an unintended runtime cloud dependency.
