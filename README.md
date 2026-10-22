# Agent Eye

Eyes for agents. A small CLI to **configure, preview and record cameras**: Mac webcams and an
Android phone over USB. You frame the shot once in the browser; afterwards an agent (or you)
records with that exact setup from the terminal.

```
npx agent-eye setup        # first run: checks tools, camera permission, opens the browser
npx agent-eye record --out clip.mp4 --duration 30
```

## What it records

| Source | Resolution | Frame rate | Notes |
|---|---|---|---|
| Android phone (USB) | up to the camera's maximum, Full HD and 4K included | 30, 60, **120, 240** | slow motion measured at 119.7 fps (1080p) and 240 fps (1080p and 720p) on a Motorola edge 40 pro |
| Mac webcam | whatever the camera offers | 15-60 | |

Android recordings are the phone's H.264 stream copied as-is (no re-encode) unless you crop or
rotate. Every recording gets a `.json` next to it with the **measured** fps, frame count and the
host clock at start and stop, so you can line the video up with logs.

A recording only counts when ffmpeg finished the file and `ffprobe` can read frames from it.
Otherwise `record` / `stop` exit with code 3 ("Recording failed"), the incomplete file is left
where it was and no `.json` is written; a `.json` left by an earlier take of the same file is
removed when the new recording starts.

## Requirements

- macOS with Node 20+ and `ffmpeg` (`brew install ffmpeg`, which includes `ffprobe`; without
  `ffprobe` recordings are not checked and the summary says so). Only macOS hosts have been tested;
  Android capture may work on Linux, and Windows finds `ffmpeg.exe` / `adb.exe` but is untested.
- For Android: `adb` (`brew install android-platform-tools`), USB debugging on, and the
  "Allow USB debugging" prompt accepted. The camera server is bundled; scrcpy is not needed.
- macOS: the first camera use asks for permission for your terminal app
  (System Settings > Privacy & Security > Camera).

`agent-eye doctor` checks all of this.

## First run

Any command that needs a camera exits with code 2 until a profile exists. `agent-eye setup`
walks through the checks, triggers the camera permission prompt and opens the browser.

## Commands

```
agent-eye setup                  first-run check and first profile
agent-eye doctor                 tools, permissions, cameras
agent-eye devices [--caps]       list cameras (and what each supports)
agent-eye configure              browser: pick camera, resolution, fps, zoom, framing; Confirm saves
agent-eye configure --set JSON   no browser. JSON, @file.json or - (stdin). Validated against the camera
agent-eye preview                browser on the saved profile, to check or adjust it
agent-eye show                   print the saved profile
agent-eye snapshot --out a.jpg   full-resolution still with the saved framing (lets an agent look)
agent-eye record --out v.mp4 --duration 30   --duration is seconds (> 0); without it, until Ctrl-C
agent-eye start --out v.mp4      record in the background (one at a time per project)
agent-eye stop                   stop it and print the summary, or the reason it failed
agent-eye status
agent-eye skill [--install]      is the agent skill in this project? --install adds or updates it
```

Options: `--profile NAME`, `--name NAME` (with `--set`), `--global`, `--no-open`, `--port N`,
`--json` / `--text`. Output is JSON whenever stdout is not a terminal. Exit codes: 0 ok,
1 error, 2 not configured or invalid input, 3 camera or tool problem.

## Agent skill

`skills/agent-eye/SKILL.md` teaches an agent to look (snapshot), record and read the summary.
`setup` offers to install it, the browser page has an **Add skill to project** button, and
`agent-eye skill --install` does it from the terminal. It goes to `.claude/skills/agent-eye/`,
and also to `.agents/skills/agent-eye/` when the project already keeps skills there. Each
place is reported as missing, current or outdated (different from the bundled copy).

## The browser page and the CLI

`setup`, `configure` and `preview` open the same page; `setup` adds the checks first and
`preview` requires an existing profile. The page's server only lives while you use it. The
profile is a file, so recording never needs the server. While the page is open **it holds
the camera**: press "Close and release the camera" (or Ctrl-C) before an agent records.
Closing the tab also releases the camera, about 10 s later; the command itself keeps waiting
for Close or Ctrl-C, and reopening its URL starts the preview again.

**Confirm and save** stores the settings together with a still of what the preview shows. It
is refused while the preview is still restarting with changed settings (camera, size, fps,
zoom, rotation), so the still always matches the saved profile. A saved crop is kept exactly
as it is until you touch the framing controls, which make crops with the frame's proportions.

## Profile

Stored in `.agent-eye/config.json` (nearest one walking up from the current directory, else
`~/.config/agent-eye/config.json`; `--global` writes there). Commit it if the team should share
the framing.

```json
{
  "source": "android:ZY22H5XCNT/0",
  "width": 1920, "height": 1080, "fps": 60,
  "zoom": 2,
  "crop": { "x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5 },
  "rotate": 0,
  "bitrate": 30
}
```

- `zoom`: the phone's own zoom (1-10 on the tested phone). Lossless; centred on the sensor.
- `crop`: digital zoom and pan, as fractions of the (rotated) frame. Forces a re-encode.
- `rotate`: 0, 90, 180, 270. Applied before `crop`.
- `bitrate`: Mbit/s. Default 20, or 40 above 60 fps.

Confirming in the browser also saves a still of the approved framing to
`.agent-eye/snapshots/<name>.jpg`.

## Security

The web UI listens on 127.0.0.1 only, and every request needs a random per-session token and a
local `Host` header, so other pages in your browser cannot reach the camera.

## Background recordings

`start` claims `.agent-eye/recording.json` under a lock, so a second `start` in the same project
is refused while one runs. The worker answers `stop` and `status` on a 127.0.0.1 port, and only
to requests carrying its random id; `stop` never signals a process by pid. `stop` during start-up
cancels it (exit 1, nothing recorded). The worker's log is `.agent-eye/worker.log`.

## Limits worth knowing

- One program at a time can use a camera: preview and record are exclusive, and a phone camera
  that another app (or a scrcpy window) holds will not start.
- The preview is 15 fps and 960 px wide whatever the recording settings are.
- Phone zoom changes restart the preview (about a second); digital zoom is instant.
- High frame rates depend on the phone's encoder. Check `measuredFps` in the summary; a warning
  is added when it falls under 90 % of what you asked for.

## Development

```
npm test
```

The tests use fake `ffmpeg`, `ffprobe` and `adb` programs and a fake phone tunnel (see
`test/helpers/fakes.js`); they never open a camera. Real capture still needs checking by hand on
the hardware listed above.

`vendor/scrcpy-server-v4.1.jar` is the unmodified scrcpy server (Apache-2.0, see `vendor/NOTICE`).
