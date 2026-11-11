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

Each frame of an Android recording carries the time the phone **captured** it (scrcpy's packet
timestamp, passed to ffmpeg as MPEG-TS), not the time it reached the Mac: at 60 fps the frames are
16.67 ms apart and a dropped frame shows up as a 33 ms gap. `frameIntervalMs` in the summary gives
the median, shortest and longest interval and how many are off by more than half the median; more
than 1 % adds a warning.

Android summaries also say what the phone camera did while recording (`camera`): where the lens was
focused (diopters and cm; the range covers every frame), whether exposure and white balance were
locked, exposure time and ISO. A warning is added when autofocus refocused during the recording or
a fixed focus did not hold, which is the usual cause of blurred takes. See **Focus and exposure**.

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
agent-eye configure --update JSON   change only these fields of a profile; null removes one ({"focus": null})
agent-eye frame --region x,y,w,h    frame that part of the picture: camera zoom, centred crop, focus on it
    [--lens auto|best|N]            on lens N, the phone's automatic switching, or the lens with the most detail
agent-eye focus [scan|auto|D]    scan: autofocus once (on --region) and fix it; auto; or D diopters
agent-eye preview                browser on the saved profile, to check or adjust it
agent-eye show                   print the saved profile
agent-eye snapshot --out a.jpg   full-resolution still with the saved framing (lets an agent look)
agent-eye record --out v.mp4 --duration 30   --duration is seconds (> 0); without it, until Ctrl-C
agent-eye start --out v.mp4      record in the background (one at a time per project)
agent-eye stop [--tail S]        stop it (after S more seconds) and print the summary, or the reason it failed
agent-eye status
agent-eye skill [--install]      is the agent skill in this project? --install adds or updates it
```

Options: `--profile NAME`, `--name NAME` and `--default` (with `--set`), `--global`, `--no-open`, `--port N`,
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
  "bitrate": 30,
  "focus": 4.25,
  "focusRegion": { "x": 0.4, "y": 0.4, "w": 0.2, "h": 0.2 },
  "exposureLock": true,
  "whiteBalanceLock": true
}
```

- `zoom`: the phone's own zoom (1-10 on the tested phone). Lossless; centred on the sensor.
- `crop`: digital zoom and pan, as fractions of the (rotated) frame. Forces a re-encode.
- `rotate`: 0, 90, 180, 270. Applied before `crop`.
- `bitrate`: Mbit/s. Default 20, or 40 above 60 fps.
- `focus` (optional, Android): a fixed focus distance in diopters, 1/metres (4 = 25 cm, 0 =
  infinity). Absent or `"auto"`: continuous autofocus.
- `focusRegion` (optional, Android): where autofocus looks, and where a focus scan measures; like
  `crop`, fractions of the frame before the crop.
- `exposureLock`, `whiteBalanceLock` (optional, Android): lock them once the camera has metered
  the scene. Absent: automatic.

### Focus and exposure

By default the phone uses continuous autofocus and automatic exposure and white balance, like
its camera app. That is fine for watching, but bad for measuring: when the scene changes a lot (a
screen flashing), autofocus searches again and blurs frames, and exposure shifts the brightness of
the whole frame for 1-2 s.

To keep them still, open `agent-eye preview`, drag over the subject (see **Framing a
selection**) or press **Focus on frame**, tick **Lock exposure** / **Lock white balance**, and
confirm. From the terminal: `agent-eye focus scan --region x,y,w,h` (autofocus once on that part
of the picture and fix it there), `agent-eye focus 4.25`, `agent-eye focus auto`, or
`agent-eye configure --update '{"exposureLock": true}'`.
`agent-eye devices --caps` shows each camera's `focusRange` and `locks`; a profile asking for
something the camera cannot do is refused. On the tested phone (Motorola edge 40 pro, back camera)
fixed focus and both locks hold at 30, 60, 120 and 240 fps.

- A fixed focus is the same in every take. The locks are taken anew at each start, about 1.5 s
  after the camera opens, on what it sees then: start with the scene in its resting state.
- With autofocus, the camera searches for about 1.5 s when it opens. `record` and `start` count
  as started only once focus has settled and the locks are on, so what happens after `start`
  returns is filmed in focus; the file itself begins with that search (`camera.focus.settledAtMs`,
  host clock, says when it ended).
- Every time the camera opens, the lens starts at infinity and exposure meters the scene again
  (1-2 s; with a fixed focus the lens goes straight to its distance instead of searching). The
  page shows the picture only after that, `snapshot` takes its still after it, and reloading the
  page keeps the camera already open (zoom, focus and locks change on it) instead of reopening it.
  Commands that film (`record`, `start`, `snapshot`, `frame`) open the camera themselves, so each
  has this start.

### Framing a selection

Drag over a part of the preview (or `agent-eye frame --region x,y,w,h`, in fractions of what
`snapshot` shows) and Agent Eye:

1. zooms the **phone's camera** as far as it can while keeping the selection centred (the phone's
   zoom is centred on the sensor, so an off-centre subject limits it), because the phone's zoom
   crops the full sensor and keeps more detail than a crop of the recorded picture;
2. autofocuses once on the selection and fixes the focus there, and makes it the focus area;
3. crops the rest digitally, centred on the selection, with the picture's proportions.

**One zoom.** The page has a single Zoom slider (and the mouse wheel), measured against the main
lens's 1× view so the same number frames the same scene on every lens. Agent Eye splits it on its
own: as much camera zoom as keeps the center in the picture (and, with a fixed focus, stays below
a lens that cannot focus that close), and a digital crop for the rest. The line under the slider
shows the split, e.g. `Camera 1.87× (lens 2 · main + sensor crop 1.9×) · digital 1.6×`, and why
the camera zoom stopped. Zoom, focus and locks change the running camera directly: the preview
does not restart (or blink) when you move them.

**Lenses.** Agent Eye numbers the lenses of the back camera from the widest (lens 1, 2, 3…) from
what the phone reports, so it works on any phone that describes its lenses (Android's
multi-camera API), not only the tested one. `agent-eye devices` lists each lens as a camera of its
own when the phone lets apps open it (`back, lens 3 · telephoto 2.16×`), plus the camera that
switches between them with the zoom (`back, all lenses (automatic)`; phones hide it, Agent Eye
finds it). In the page:

- the **Lens** buttons choose: **Auto** (the phone switches with the zoom; a dot marks the lens in
  use), or one lens, which then films alone at any zoom. The zoom and the framed spot are kept;
- the chip under the picture always says the lens in use;
- after a drag, the note lists the **detail by lens**: how many sensor pixels each lens would put
  across the selection, or why it cannot (the subject does not fit, or is closer than the lens
  can focus). When another lens is better, a **Use lens N** button switches to it and frames the
  same spot again. `frame --lens best` does the same from the CLI; `--lens 2` or `--lens auto`
  frames on that camera.

On the tested Motorola edge 40 pro:

- the main lens focuses from 10 cm, the ultrawide from 2.5 cm, the **telephoto only from 50 cm**,
  and it reports "focused" even when the subject is nearer. Framing a closer subject therefore
  stays on the main lens (below about 2×) and says so; the page warns when the lens in use cannot
  reach the focus distance;
- the camera switches lenses on its own, with hysteresis (telephoto from about 2.2× going up,
  until about 2.0× coming down); the label shows the lens it actually uses;
- the all-lenses camera cannot do slow motion (every 120/240 fps mode fails), so it is offered
  only up to 60 fps. For slow motion use the plain back camera: its zoom is a crop of the main
  sensor, the same picture the all-lenses camera gives below 2×.

A config holds several named profiles and one default, used when a command has no `--profile`.
`configure --set JSON --name hs240` (or `--profile hs240`, or `"name": "hs240"` in the JSON)
writes only `hs240`, creating it if new; without a name it updates the default profile. The
default changes only with `--default`, or when the config has no valid default (none yet, or
one naming a profile that no longer exists).

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
- Changing the camera, resolution, frame rate or rotation restarts the preview (about a second);
  zoom, focus and locks change live.
- High frame rates depend on the phone's encoder. Check `measuredFps` in the summary; a warning
  is added when it falls under 90 % of what you asked for.
- Without `exposureLock`, exposure on the phone is automatic: a large change in what the camera
  sees (a screen flashing black) shifts the brightness of the whole frame for 1-2 s. Manual
  exposure time and ISO are not offered; a lock keeps whatever the camera chose at start. To
  measure brightness, lock exposure and still normalise against a fixed region outside the
  subject. Agent Eye's crop is applied on the Mac and does not change what the camera meters.
- Frames reach the Mac a moment after they are captured, so `stop` misses the last instant before
  it runs. When the last event matters, use `stop --tail 1` (or start the sequence after
  `start` returns and leave a second at the end).

## Development

```
npm test
```

The tests use fake `ffmpeg`, `ffprobe` and `adb` programs and a fake phone tunnel (see
`test/helpers/fakes.js`); they never open a camera. Real capture still needs checking by hand on
the hardware listed above. `AGENT_EYE_DEBUG_SERVER=1` prints the phone camera server's log.

`vendor/scrcpy-server-v4.1-agent-eye.jar` is the scrcpy 4.1 server (Apache-2.0) with
`vendor/scrcpy-camera-controls.patch` applied: manual focus, exposure and white balance locks, and
the 3A reports behind `camera` in the summary (see `vendor/NOTICE`). `scripts/build-server.sh`
rebuilds it (git, JDK 17, Android SDK platform 36 and build-tools 36.0.0).
