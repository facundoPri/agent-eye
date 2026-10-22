---
name: agent-eye
description: Camera through the agent-eye CLI. Use to record or film a video of something physical, to take a still and look at a device or setup, or when a camera is "busy" or "not configured".
---

The human owns the framing; the agent records with it. A **profile** (camera, resolution,
fps, zoom, crop) is chosen in the browser by the human and saved in `.agent-eye/config.json`.
Commands and flags: `agent-eye help`. Run as `agent-eye` if it is on PATH, otherwise
`npx agent-eye`. Output is JSON when piped.

1. **Look.** `agent-eye snapshot --out <dir>/look.jpg`, then open the image. Done when you
   have seen that the subject is in frame and in focus. If it is not, ask the human to run
   `agent-eye preview` and confirm a new framing; change the profile yourself with
   `agent-eye configure --set` only when asked to.
2. **Record.** Fixed length: `agent-eye record --out <file>.mp4 --duration <s>`. Around other
   actions (flashing, a test sequence): `agent-eye start --out <file>.mp4`, do the work,
   `agent-eye stop --tail 1` (the extra second keeps the last event in the file). Done when the
   summary JSON comes back with an empty `warnings` list.
3. **Report** the file path, `measuredFps` and `frames`. To line the video up with logs use
   `startedAtMs` and `stoppedAtMs` (host clock, epoch ms); the same summary is saved next to
   the video as `<file>.json`.

## Exit codes

- **2, not configured or invalid input**: framing needs a person at the browser. Ask the
  human to run `agent-eye setup`, then continue.
- **3, camera busy**: one program at a time can hold a camera. A browser preview
  (`agent-eye preview`, `configure` or `setup`) holds it until its Close button, Ctrl-C, or
  about 10 s after its tab closes; so does a scrcpy window or the phone's camera app. Ask the
  human to close it, then retry.
- **3, "Recording failed"** from `record` or `stop`: the file is not a finished video. Report
  the reason and record again; a recording exists only when the summary comes back.
- **1, "already running"** from `start`: another background recording holds this project.
  `agent-eye status` shows its file; stop it only if it is yours.
- **3, phone missing or unauthorized**: the phone must be unlocked, on USB, with the
  "Allow USB debugging" prompt accepted. `agent-eye doctor` shows what is missing.

`measuredFps` is counted from the file; a warning appears when it is under 90 % of the
profile's fps. Report that number, never the requested one. Frame times are capture times;
`frameIntervalMs` shows their spacing, and a warning says when it is irregular.

Brightness is not a measurement: the phone's auto exposure cannot be locked and shifts the
whole frame for 1-2 s after a big change in the scene. When analysing luminance, normalise
each frame against a fixed region outside the subject.
