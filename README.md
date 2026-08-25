# SweetSpot Web

SweetSpot Web is the browser dashboard for SweetSpot, an Android TV audio-calibration app. Open it on a phone or laptop to pair with a TV, control its equalizer, manage profiles, run room calibration, and inspect diagnostics.

The Android TV app lives in the separate `sweetspot` repository. The two repositories use the same v1 protocol and are released together.

## How the dashboard works

Nuxt generates a static Vue dashboard. The Cloudflare Worker serves the generated files and routes room connections to a Durable Object.

- The TV connects as the `device` role.
- The browser connects as the `client` role.
- `RoomDO` owns room membership and forwards protocol envelopes over WebSockets.
- The TV owns safety-critical calibration state, candidate acceptance, and rollback.
- The browser keeps microphone capture and audio analysis local. It sends compact calibration results and control messages, not raw microphone samples.

The dashboard uses the current WebSocket transport only. It has no HTTP mailbox fallback, WebRTC path, or legacy heartbeat protocol.

During automatic calibration, the TV gives the instructions. After you start calibration, the dashboard locks normal controls while it shows progress and keeps cancellation available.

## Requirements

- [Bun](https://bun.sh/)
- A running SweetSpot Android TV app for a connected session
- Cloudflare Wrangler authentication for deployment

Use Python and Pillow only if you need the optional frequency-response digitizer in `scripts/digitize-frequency-response.py`.

## Start the dashboard

Install dependencies and start the Nuxt development server:

```bash
bun install
bun run dev
```

Open `http://localhost:3000`. Enter the pair code shown on the TV, or scan the QR code shown by the TV.

`bun run dev` starts Nuxt only. It does not start the Cloudflare Worker or `RoomDO`, so a live TV session needs the deployed Worker or a separately running local Worker.

To serve the generated dashboard and Worker locally:

```bash
bun run generate
bunx wrangler dev
```

Wrangler prints the local URL. A TV on another device needs a URL that it can reach.

## Commands

| Command | Purpose |
| --- | --- |
| `bun install` | Install dependencies from `bun.lock`. |
| `bun run dev` | Start the Nuxt development server. |
| `bun run test` | Run the Bun test suite. |
| `bun run generate` | Generate the static site in `dist/`. |
| `bun run verify:transport` | Check the web and Android sources for the WebSocket-only contract. |
| `bun run deploy` | Generate the site and deploy the Worker with Wrangler. |

The project has no separate `build` or `preview` script. Use `bun run generate` for the production artifact and `bunx wrangler dev` to preview the Worker locally.

`bun run verify:transport` expects the Android checkout at `../sweetspot`.

## Validate a deployed room

The mailbox presence check opens a device socket and a client socket, then verifies the TV-first `room.ready` state:

```bash
bun scripts/mailbox-presence-check.mjs
```

Set `SWEETSPOT_MAILBOX_URL` to check another Worker deployment:

```bash
SWEETSPOT_MAILBOX_URL=https://example.workers.dev bun scripts/mailbox-presence-check.mjs
```

The presence check does not replace a real pair-code session. For connected-session acceptance, exercise the WebSocket connection, device commands, state snapshots, calibration progress, cancellation, validation, and rollback with a running TV.

## Deploy

The Worker configuration is in [`wrangler.jsonc`](./wrangler.jsonc). It declares the static asset directory, the `RoomDO` Durable Object, and the `sweetspot.darelisme.my.id` custom domain.

After authenticating Wrangler, deploy with:

```bash
bun run deploy
```

This command runs `bun run generate` before `bunx wrangler deploy`.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `app/` | Dashboard pages, Vue components, connection state, microphone capture, measurement analysis, and correction logic. |
| `worker/index.ts` | Serves `dist/` and routes `/api/room/{code}/ws` requests to `RoomDO`. |
| `worker/room.ts` | Cloudflare Durable Object that validates envelopes, tracks open sockets, queues bounded messages, and broadcasts device messages. |
| `shared/types/protocol.ts` | Canonical v1 message types, payload validation, and state shapes shared with Android. |
| `shared/types/README.md` | Message envelope and message-type reference. |
| `shared/types/TRANSPORT.md` | Room WebSocket lifecycle, presence, queue, and delivery rules. |
| `server/api/calibration/profiles.get.ts` | Static microphone-profile catalog endpoint. |
| `public/` | Static assets, the capture worklet, and microphone calibration profiles. |
| `scripts/` | Transport checks, room presence checks, and measurement utilities. |

## Room WebSocket contract

The Worker accepts these room socket paths:

```text
GET /api/room/{code}/ws?role=device
GET /api/room/{code}/ws?role=client
```

The room validates every v1 envelope, rejects unknown or oversized payloads, and treats only open WebSockets as live membership. Messages are delivered at most once. The browser requests a fresh state snapshot after reconnect instead of relying on replayed snapshots.

Read [`shared/types/README.md`](./shared/types/README.md) before changing a message type. Read [`shared/types/TRANSPORT.md`](./shared/types/TRANSPORT.md) before changing room behavior. Update the Android consumer and its tests when the wire contract changes.

## Calibration boundaries

Calibration runs in the browser and uses the TV for playback and user instructions. The browser keeps captured PCM and FFT or impulse-response work local. It sends compact response curves and calibration commands through the room WebSocket.

The calibration flow preserves session IDs, repeatability checks, progress, cancellation, automatic candidate validation, and TV-owned rollback. A successful local test or static generation run does not prove microphone behavior on iPhone Safari, audio routing on a real TV, hosted Worker behavior, or an end-to-end connected session.

Keep those checks separate when reporting validation results.
