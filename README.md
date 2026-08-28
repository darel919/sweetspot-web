# SweetSpot Web

SweetSpot Web is the HTTPS Nuxt dashboard for SweetSpot, the Android TV audio-tuning app. It runs on a phone or laptop and provides EQ controls, profiles, diagnostics, and the remote microphone surface for TV-owned calibration.

## Runtime architecture

```text
phone Safari  -- direct WebRTC DataChannels when possible --  Android TV
      \                                                     /
       \-- HTTPS Worker: static dashboard + short SDP/ICE signaling
```

The dashboard is a secure browser application. Cloudflare hosts the static site and provides short-lived signaling rendezvous. Once the ordered, reliable `control` and `capture` DataChannels open, commands, state, EQ changes, cancellation, and PCM stay on the direct peer path. Cloudflare does not relay production calibration or control traffic.

The `control` channel carries envelopes, replies, TV-owned job state, diagnostics, capability negotiation, and cancellation. The `capture` channel carries bounded binary Float32 mono PCM frames. The capture producer honors `bufferedAmount` and a bounded queue so a recording cannot block control traffic or consume unbounded browser memory.

The collapsed developer details show browser transport diagnostics and can request the corresponding redacted TV peer snapshot when a direct session is available.

The TV owns job IDs, capture timing, integrity validation, acoustic analysis, accepted evidence, correction, validation, rollback, persistence, and recovery. The browser owns microphone permission, capture settings and profile metadata, PCM streaming, rendering, and cancellation requests. Browser analysis helpers are for diagnostics and parity fixtures only.

## Pairing and recovery

Scan the current QR code displayed by the TV. It contains a short display code, a random rendezvous ID, and a random pair secret. Pairing credentials expire if unused, but expiry does not terminate an authenticated direct peer. A second dashboard cannot silently replace an active peer. Browser reload restores the pairing link's tab generation and requests the current TV state.

SweetSpot expects TV and phone to share a normal home network. ICE retries and restarts automatically when recovery is safe. Guest Wi-Fi, client isolation, VPNs, and other network policy can prevent a direct path; the dashboard reports an actionable error and does not silently route large calibration captures through a paid relay.

During active calibration, unrelated navigation stays locked and cancellation remains available. The phone stops its microphone when the TV acknowledges cancellation or when a safe local abort is required. The TV remains authoritative.

## Requirements and development

- [Bun](https://bun.sh/)
- A running SweetSpot Android TV service for an end-to-end session
- Wrangler authentication for deployment

```bash
bun install
bun run dev
```

`bun run dev` starts Nuxt. A live phone-to-TV session also needs the signaling Worker, either deployed or run locally:

```bash
bun run generate
bunx wrangler dev
```

The Worker serves the generated `dist/` site and the `/api/signaling/{rendezvousId}/ws` signaling endpoint. It does not carry application envelopes or PCM.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the Nuxt development server. |
| `bun run test` | Run the Bun unit and contract tests. |
| `bun run typecheck` | Run strict Vue and TypeScript checks. |
| `bun run lint` | Run Oxlint with the repository rules. |
| `bun run verify:protocol` | Check shared protocol parity. |
| `bun run verify:transport` | Check that production source uses direct transport and signaling-only Worker behavior. |
| `bun run generate` | Generate the static dashboard. |
| `bun run deploy` | Generate and deploy the dashboard Worker. |

Use `bun run test`, `bun run typecheck`, `bun run lint`, `bun run verify:protocol`, `bun run verify:transport`, and `bun run generate` after transport or protocol changes. Real Safari microphone behavior, direct connectivity, Android audio behavior, and cloud-independence need device acceptance testing.

## Repository layout

```text
app/
├── components/             dashboard UI by domain
├── composables/            connection and calibration orchestration
└── lib/
    ├── audio/              microphone capture and diagnostic analysis
    ├── pairing/            browser pairing helpers
    └── transport/          protocol, signaling, WebRTC, and backpressure
shared/
├── types/                  envelope and payload contract
└── transport/              signaling, capabilities, and capture-stream wire format
worker/
├── index.ts                static assets and signaling route
└── signaling.ts            short-lived SDP/ICE rendezvous Durable Object
public/                     microphone worklet and profiles
scripts/                    generation and verification tools
```

Keep generic transport independent from calibration audio and UI. Keep the shared wire format transport-agnostic. Read [`shared/types/README.md`](shared/types/README.md) and [`shared/types/TRANSPORT.md`](shared/types/TRANSPORT.md) before changing the contract, then update the Android consumer and cross-language fixtures in the paired repository.

## Validation boundaries

Unit tests and static generation do not prove iPhone Safari capture, Android TV DSP, Wi-Fi behavior, peer recovery, a 30-minute connection, or the Cloudflare-blocked-after-connect test. Record those as separate evidence. The required acceptance test blocks Cloudflare after DataChannels open, then completes calibration, EQ changes, state fetch, cancellation or restart, and finalization over the direct peer.
