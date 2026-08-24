# SweetSpot Calibration Execution Checklist

This document is an implementation checklist for an LLM working across both repositories:

- `darel919/SweetSpot` — Android TV / Kotlin
- `darel919/sweetspot-web` — Safari/web dashboard + Cloudflare room transport

Use the latest `main` in both repositories before making changes.

## Goal

Make Auto Room Calibration behave like a TV-led appliance flow:

1. The TV gives all calibration instructions.
2. The iPhone acts as the microphone and only shows a passive instruction plus Cancel.
3. Calibration automatically validates the applied candidate against the pre-calibration baseline.
4. A worse candidate is automatically rolled back.
5. The result is clearly shown as improved, inconclusive, or worse.
6. Keep the current lean WebSocket transport; do not add WebRTC unless a new hard requirement proves it necessary.
7. Only show the pairing QR when the TV is actually ready for a dashboard connection.

Do not implement this as a multi-phase roadmap. Work through the TODOs below and complete as many as possible in one coherent change set.

---

## Already Done — Do Not Rebuild

The following work already exists and should be preserved unless a bug is found:

- Browser calibration locks the rest of the dashboard using `inert`.
- Browser scrolling is disabled while calibration is active.
- Vue route navigation is blocked while calibration is active.
- Browser unload is guarded during calibration.
- Screen Wake Lock support exists.
- Android has a dedicated fullscreen `CalibrationActivity`.
- Android has a TV-side calibration graph.
- TV calibration progress/status is already sent into `CalibrationActivity`.
- Calibration candidate transaction/rollback state exists on Android.
- Before/after validation metrics exist in the web app.
- Web transport is WebSocket-only.
- Android uses a persistent OkHttp WebSocket with protocol pings.
- Cloudflare Durable Object transport uses accepted/hibernatable WebSockets.
- Raw microphone PCM is processed locally in Safari. Do not start relaying PCM through Cloudflare.
- Safari microphone capture already requests:
  - `echoCancellation: false`
  - `noiseSuppression: false`
  - `autoGainControl: false`
  - mono capture
- Pink noise already exists and is appropriate for the listening-volume preflight.

Do not reintroduce HTTP polling/fallback transport.

Do not replace the current WebSocket transport with WebRTC as part of this task.

---

## TODO — Automatic Before/After Validation

### Required behavior

The normal automatic calibration flow must become:

`baseline measurement -> calculate correction -> stage candidate -> automatically validate candidate -> classify result -> keep or rollback -> show final result`

The user should not normally need to press a separate `Run validation sweep` or `Validate candidate` button.

### Web changes

In `sweetspot-web`:

- After a recommended correction is successfully staged as a calibration candidate, automatically start validation when all required conditions are available.
- Reuse the existing center-position baseline and validation measurement infrastructure.
- Do not run validation if:
  - candidate staging failed;
  - DSP readback is not verified;
  - baseline repeatability is insufficient;
  - the session is cancelled;
  - the microphone/capture path fails;
  - the candidate transaction no longer matches the candidate being validated.
- Ensure automatic validation cannot start twice because of reactive state updates, reconnects, duplicate snapshots, or repeated candidate messages.
- Preserve manual validation only as a diagnostics/recovery action if useful. It must not be required by the normal Auto Room Calibration flow.

### Validation result semantics

Do not treat "not significantly worse" as the same thing as "successfully improved".

Classify validation into at least:

- `improved`
- `inconclusive`
- `worse`

Use existing target-error RMS and repeatability information.

Expected logic:

- `worse`: post-calibration target error is meaningfully worse than baseline beyond the accepted measurement tolerance.
- `improved`: post-calibration target error is meaningfully lower than baseline by more than the uncertainty/tolerance threshold.
- `inconclusive`: the delta is too small relative to measurement tolerance/repeatability, or validation quality is insufficient.

Do not invent fake precision. Reuse existing repeatability and validation metrics.

If the existing Android protocol only supports `passed/worse/inconclusive`, either:

1. extend the protocol safely to represent `improved`, or
2. keep the transport enum compatible while exposing an unambiguous user-facing `improved/inconclusive/worse` result derived from metrics.

Pick the smaller safe change.

### Automatic rollback

If validation is `worse`:

- automatically request rollback of the staged candidate;
- wait for TV state to confirm rollback/recovery;
- do not present calibration as successful;
- show a concise final result explaining that the candidate was worse and the previous calibration was restored.

If rollback fails, surface a serious error and preserve enough transaction state for recovery after reconnect/restart.

### Successful/inconclusive candidate handling

For `improved`:

- automatically finalize/accept the candidate if doing so is safe with the existing transaction model;
- otherwise perform the smallest transaction change necessary so the normal automatic flow ends without another user confirmation.

For `inconclusive`:

- prefer safety over silently accepting a questionable candidate;
- either restore the previous calibration automatically or keep the candidate pending only if there is a strong existing safety reason;
- the final UI must clearly say the result could not be proven better.

Document the chosen behavior in code comments/tests.

### Do not use pink noise for validation

Keep swept-sine based response measurement for before/after validation.

Pink noise should remain the volume-setting preflight signal, not the frequency-response validation signal.

---

## TODO — TV Owns All Calibration Instructions

The TV must become the single source of interaction/instructions during calibration.

### Android / Kotlin

Update `CalibrationActivity` and `MeasurementController` so all user actions required during calibration can be performed from the TV remote.

Move these confirmations from the phone to the TV:

- listening volume confirmed / continue;
- move-to-next-position confirmed / continue.

Remove or rewrite Android text that currently says things such as:

- `continue on the phone`
- `follow the instructions on the phone`

The TV should never instruct the user to interact with the phone during calibration except for the unavoidable Safari microphone permission prompt before/at startup.

Suggested TV interaction model:

- remote OK/Select = primary Continue action;
- Back = Cancel calibration;
- only one obvious primary action at a time.

Add/extend service actions or the existing calibration activity/service bridge as required so the TV can advance loudness and position-pause states without the web UI providing those clicks.

Ensure cancellation from either TV Back/Cancel or the phone Cancel button terminates the same calibration session safely.

### Web / iPhone

During active calibration, the iPhone UI should be deliberately minimal.

Replace the current detailed calibration overlay with approximately:

- title/status indicating calibration is active;
- primary text: `Follow the instructions on your TV`;
- secondary text explaining the phone must remain on/open because it is being used as the microphone;
- `Cancel calibration` button.

The phone must NOT show normal-flow controls for:

- `Volume set, continue`
- position `Continue`
- candidate validation
- candidate acceptance

Do not duplicate detailed TV position/channel instructions on the phone in the normal calibration overlay.

It is acceptable to show a small generic state such as `Measuring` / `Analyzing`, but the TV remains authoritative.

Keep the browser calibration lock already implemented.

---

## TODO — TV Calibration UI Redesign

Keep the existing `CalibrationActivity`, but make it easier to understand from across a room.

Treat the TV UI as a state-driven calibration screen, not a debug status page.

### Primary UI states

At minimum design for:

1. `Set listening volume`
2. `Move phone to position`
3. `Measuring`
4. `Analyzing`
5. `Validating`
6. `Complete — improved`
7. `Complete — inconclusive`
8. `Calibration rejected — previous settings restored`
9. fatal/recovery error

### UI requirements

- One large primary instruction.
- High contrast and large TV-readable typography.
- Clear progress such as `Measurement 4 of 12` where applicable.
- Estimated remaining time only when meaningful.
- Show the current position visually/textually.
- Keep the graph on TV during measurement/result as already intended.
- Avoid dumping technical diagnostics into the main calibration screen.
- Keep technical details for diagnostics/web debug UI.
- Remote focus must always land on the correct action.
- The user must never wonder whether calibration is still running, waiting for them, finished, failed, or rolled back.

Prefer simple native Android views and low resource use. Do not add a heavyweight UI/runtime dependency just to redesign this screen.

---

## TODO — QR Visibility

In Android `OverlayController`, the QR must only be visible when the device is genuinely ready and waiting for a dashboard.

Current behavior effectively allows the QR whenever the state is anything except connected.

Change the condition so the QR is shown only when:

`relayState == RELAY_WAITING`

Expected states:

- `RELAY_DISCONNECTED` -> no QR; show offline/network status.
- `RELAY_CONNECTING` -> no QR; show connecting status.
- `RELAY_WAITING` -> show QR + pairing URL/code; this is the ready-to-scan state.
- `RELAY_CONNECTED` -> no QR; show connected status and follow existing dismissal behavior.

Add/update unit tests if practical around QR/pairing-state visibility logic. If `OverlayController` is difficult to unit-test directly, extract the visibility decision into a small pure function and test that.

---

## TODO — Keep Cloudflare Usage Low

Do not redesign the transport unless measurements prove the current WebSocket-only architecture is still problematic.

### Preserve

- one persistent device WebSocket;
- one browser WebSocket while the dashboard is open;
- protocol-level OkHttp ping rather than application heartbeat messages where possible;
- hibernatable Durable Object WebSockets;
- local Safari PCM processing;
- compact measurement/result messages instead of PCM streaming;
- no HTTP long polling fallback.

### Audit for accidental request/message spam

Check for unnecessary application messages during calibration and idle dashboard use.

Pay particular attention to:

- calibration keep-alive/progress messages;
- duplicate state requests after reconnect/reactive updates;
- repeated presence handling;
- duplicate candidate validation triggers;
- high-frequency diagnostic updates.

Reduce only messages that are genuinely unnecessary. Do not weaken session watchdog/recovery safety just to save tiny amounts of traffic.

Do not add WebRTC audio or RTCDataChannel in this task.

---

## TODO — Production Auto-Correction Safety Gates

Do NOT simply flip these booleans to `true`:

- `BAND_TRANSFER_CHARACTERIZED`
- `INDEPENDENT_ROUTING_VERIFIED`

They currently protect unverified hardware behavior.

Do not bypass the microphone capture-path eligibility gate either.

The iPhone 17 Pro profile currently states that the Safari `getUserMedia` capture path is unvalidated. Automatic correction must not be enabled merely by changing `capturePathStatus` without evidence.

### Required evidence before enabling the gates

Create/retain a separate diagnostic path to obtain evidence for:

- actual 64-band transfer behavior on the target TCL TV output path;
- whether left/right per-channel routing is acoustically independent;
- Safari iPhone 17 Pro raw-ish capture behavior with browser processing disabled/requested disabled;
- repeatability of Safari captures relative to a trusted measurement reference.

Only enable a gate after corresponding real-device evidence supports it.

This checklist does not require fabricating that evidence. If hardware measurements are unavailable, leave the gates closed and keep the diagnostic UI usable.

---

## Tests / Acceptance Criteria

Add or update automated tests where the codebase already supports them.

### Web tests

Verify:

- candidate staging triggers validation exactly once when eligible;
- validation does not auto-start without a valid repeatable baseline;
- validation does not auto-start when live DSP status is unverified;
- `improved`, `inconclusive`, and `worse` classification boundaries;
- `worse` automatically requests rollback;
- duplicate/replayed state does not start duplicate validation;
- cancel stops the flow;
- phone calibration overlay contains no normal-flow Continue/Volume confirmation controls;
- existing dashboard lock/navigation protections still work.

### Android tests

Verify where practical:

- TV action can confirm loudness;
- TV action can confirm position transition;
- Back/Cancel aborts the correct session;
- stale session IDs cannot advance another session;
- QR is only visible in `RELAY_WAITING`;
- candidate rollback/recovery behavior still survives restart/failure conditions;
- existing calibration transaction tests remain green.

### Manual end-to-end acceptance

On the actual TCL Android TV + iPhone Safari:

1. Launch SweetSpot.
2. TV connects to relay.
3. QR appears only once TV reaches waiting/ready state.
4. Scan QR.
5. Start Auto Room Calibration.
6. Safari microphone permission may appear.
7. After permission, the phone shows only `Follow the instructions on your TV` plus Cancel.
8. TV asks user to set listening volume using pink noise.
9. User confirms using TV remote.
10. TV directs every measurement position change.
11. User confirms position changes using TV remote.
12. TV shows measuring/analyzing progress and graph.
13. Candidate correction is staged automatically when eligible.
14. Validation begins automatically without asking the user to visit the phone UI.
15. Final result is one of improved / inconclusive / worse.
16. Worse candidate is automatically rolled back and TV confirms restoration.
17. Improved candidate becomes the final active calibration without requiring a second hidden web-dashboard interaction.
18. Web UI unlocks only after the calibration/rollback/finalization transaction is actually complete.
19. Response/result graph becomes available in the web UI after completion.
20. Cancelling from TV or phone leaves DSP/calibration state consistent.

---

## Implementation Constraints

- Keep the Android app lean for low-resource TV hardware.
- No Let's Encrypt/TLS termination on the TV.
- No mDNS server/discovery implementation in the Android app.
- No embedded heavyweight browser/UI framework on Android.
- No WebRTC addition for this task.
- No raw PCM relay through Cloudflare.
- Do not weaken calibration transaction/rollback safety.
- Do not silently enable unverified correction paths.
- Prefer extending existing protocol/state types instead of creating a parallel calibration protocol.
- Preserve backward-safe handling of reconnects and stale messages.

---

## Completion Output Expected From Implementing LLM

When implementation is complete, report:

- files changed in each repository;
- behavior changed;
- tests added/updated and their results;
- any hardware-only safety gates intentionally left disabled;
- any manual real-TV/iPhone tests still required;
- any Cloudflare message/request behavior that was changed;
- exact remaining blockers, if any.
