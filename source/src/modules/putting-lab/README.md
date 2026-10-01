# Clarity Putting Lab

An overhead-camera putting gate that runs in the phone browser. The phone looks
straight down at the ball; the lab measures the putter face, the putter path
and the ball's start line on every putt, shows them straight away, and re-arms
for the next putt with no taps in between.

It is a measurement problem, not an object-recognition one: calibrate
aggressively once, then track a known shape in a known plane with prediction,
small search windows and rigid-body maths. There is no machine-learning model
anywhere in it.

## Where things are

| File | What it does |
| --- | --- |
| `PuttingLabPage.tsx` | The page (main menu > Putting Lab): intro, then the full-screen live gate |
| `capture.ts` | Rear camera (`getUserMedia`), motion sensors, and the frame pump |
| `engine.worker.ts` | Runs the engine off the main thread, one frame at a time |
| `overlay.ts` | Draws the aim line, ball spot, traces, face lines and the debug layers |
| `engine/` | The measuring engine. No browser APIs, so all of it runs under `npm test` |
| `/public/putting-lab/calibration-template-a3.svg` | The sheet coaches print (made by `engine/template.ts`) |

Inside `engine/`:

| File | What it does |
| --- | --- |
| `geometry.ts` | Vectors, homography, rigid fits, line and curve fits |
| `luma.ts`, `blobs.ts` | The brightness plane, blob finding, sub-pixel spot centres |
| `template.ts` | The template layout, its detector, and the printable SVG |
| `coordinates.ts` | Camera pixels -> green millimetres -> the virtual aim |
| `motion.ts` | Tilt warning and the camera-moved tripwire |
| `ball.ts` | Ball detection and tracking (at rest, then rolling) |
| `putter.ts` | Putter calibration and its three witnesses (stickers, texture, face edge) |
| `tracker.ts` | Kalman filter and the confidence-weighted fusion of the witnesses |
| `stroke.ts` | Impact time, the putt's numbers, consistency, validation |
| `engine.ts` | The session: calibration steps, the live gate, the putts |

## How a session runs

1. **Template.** Lay the printed A3 template on the green, ball off the black
   disc. The detector finds its eight black marks by shape and size and solves
   camera pixels -> green millimetres from all eight, after six steady
   sightings. The motion sensors only warn about tilt; they never define the
   measurement frame.
2. **Ball.** Put a ball on the disc. Its centre confirms the origin and its
   measured size checks the print scale.
3. **Putter.** Set the face square on the printed line, touching the ball, and
   hold still. The lab learns this putter: its width, where its visible edge
   sits relative to the true face, its texture, and any stickers.
4. **Lift the template.** The calibration stays.
5. **Putt.** Ready -> putt -> Face / Path / Start with the trace -> Ready.

## Conventions

- World: ball at the origin, +y down the physical calibration line, +x right.
- Every angle is a direction angle: **positive = right**. Face, path and start
  all use it, so face-to-path is face minus path.
- The virtual aim rotates about the ball. Changing it recalibrates nothing, and
  every stored putt is re-read against the new aim (samples are stored in
  world coordinates for exactly that reason).

## Tracking the putter

Three witnesses, none of which owns the truth:

| Witness | Sees |
| --- | --- |
| stickers | Three bright stickers on the head, matched as a triangle. Optional ("Enhanced tracking"); they need not be placed precisely, calibration measures where they are. |
| texture | Marks on the head, matched against how calibration says they should look at the predicted position. |
| face edge | The face's top edge, plus the toe end. Works on a completely plain putter. |

A Kalman filter predicts where the putter is heading and folds each reading in
by its own confidence and precision. A reading far from the prediction is
refused, unless confident readings keep disagreeing for several frames, in
which case the track re-anchors on them. A lost putter is only looked for
behind the ball, where the golfer will set it.

## What the browser limits

- **Frame rate.** Phone browsers give 30-60 frames a second. The start line is
  reliable at 30; face and path get coarser as the frame rate drops, and the
  screen says so below 50.
- **Exposure.** A browser cannot lock a short shutter, so how blurred a fast
  putter looks depends on the light. Good light helps.
- **Height above the green.** The putter top and ball centre sit above the
  green but are measured as if on it. With the phone overhead this scales
  distances by about 2% and leaves angles essentially unchanged; speeds read
  about 2% low.

## Accuracy

`engine/engine.test.ts` draws putts through a virtual tilted camera (with
noise and anti-aliased edges), runs the full calibration, and checks the
numbers against the known truth: within about 0.1 degrees on face and path
at 120 fps, and within 0.3 / 0.6 degrees at 30 fps, with the start line
within 0.15 degrees and speed within a few percent.

That proves the maths, not real-world accuracy. The lab's **Validate** button
measures it against the printed lines (the putter on the square line or the
+/-1 and +/-2 degree lines, or balls rolled along the calibration line) and
reports bias, spread and worst error. Measure on a real green before quoting
any accuracy.

## Changing the template

Edit the layout in `engine/template.ts`, then regenerate the printable sheet:

```bash
PUTTING_LAB_WRITE_TEMPLATE=1 npx tsx --test src/modules/putting-lab/engine/engine.test.ts
```

## Not done yet

- Putts are not saved to players, lessons or reports.
- Three-dot balls: the dots are detected and kept with each ball sample, but
  nothing uses them yet (spin and identity later).
- Stickers are found by brightness, not colour.
