# SweetSpot wire protocol v1

This is the transport-agnostic message contract between the browser dashboard (`client`) and the Android TV (`device`). Runtime transport details are in [`TRANSPORT.md`](./TRANSPORT.md). The TypeScript definitions and validators in `protocol.ts` are paired with the Android protocol implementation and cross-language fixtures.

## Envelope

```json
{
  "v": 1,
  "id": "msg_01J...",
  "type": "state.get",
  "ts": 1787520000000,
  "payload": {},
  "replyTo": "msg_01J...",
  "expiresAt": 1787520030000,
  "transportSessionId": "peer-generation"
}
```

`id` is unique for the sender. `replyTo` identifies a request. `ts` is informational. `expiresAt` bounds queued work during reconnect. `transportSessionId` fences envelopes to the authenticated direct peer generation and is not a calibration job ID.

Unknown optional fields are ignored. Unknown message types, malformed payloads, oversized payloads, stale session IDs, and invalid binary frames are rejected. JSON payloads remain bounded by `MAX_PAYLOAD_BYTES`.

The protocol includes device-targeted commands for state, engine, profiles, calibration jobs, capture readiness, validation, import/export, cancellation, and diagnostics. Device-published messages include state snapshots and changes, calibration actions and results, capture status, job state, and diagnostic events. The complete type and payload list is in `protocol.ts`.

The `diagnostics.transport` request returns a bounded TV peer snapshot. Session IDs are redacted before publication; it is intended for the dashboard's developer details, not normal user-facing error copy.

## Ownership

The TV issues calibration jobs, actions, revisions, and timing. It validates capture metadata and integrity, performs acoustic analysis, accepts evidence, computes correction, stages and validates candidates, rolls back unsafe candidates, persists state, and recovers jobs.

The browser requests a TV-issued capture, opens the microphone, selects and sends the complete versioned microphone profile, streams Float32 mono PCM, renders TV-owned state, and requests cancellation. Browser analysis is diagnostic/parity support only. A browser message cannot declare a measurement accepted.

## Capture stream

The capture channel uses the versioned `SSCS` stream format described in [`TRANSPORT.md`](./TRANSPORT.md). It has `capture.begin`, ordered `capture.chunk`, and `capture.end` frames. Metadata includes the job and capture IDs, physical position and channel, actual sample rate, sample count, settings, user agent, microphone profile identity and revision, timestamp, and SHA-256 content hash.

Float32 samples are little-endian and mono. Chunks are bounded to 16 KiB of PCM and complete frames to 32 KiB. The TV counts bytes and samples, hashes incrementally, rejects gaps or conflicts, verifies the final metadata and SHA-256, and atomically finalizes the temporary file before analysis. Raw PCM is temporary by default.

Read this document and [`TRANSPORT.md`](./TRANSPORT.md) before changing a wire shape. Update both repositories' fixtures, validators, tests, and documentation together.
