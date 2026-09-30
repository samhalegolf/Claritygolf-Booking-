# Clarity Putting Lab

An overhead-camera putting gate for the Clarity Booking staff app. A phone or
iPad looks straight down at the ball; the lab measures the putter face, the
putter path and the ball's start line on every putt, shows them straight away,
and re-arms for the next putt with no taps in between.

It is a measurement problem, not an object-recognition one: calibrate
aggressively once, then track a known shape in a known plane with prediction,
small search windows and rigid-body maths. There is no machine-learning model
anywhere in it.

## Layout

```
native/clarity-putting-lab/
  Package.swift                     two targets, see below
  ios/Sources/PuttingLabCore/       the measurement engine (Foundation only)
  ios/Sources/ClarityPuttingLabPlugin/  the iOS shell (AVFoundation, Core Motion, UIKit, Capacitor)
  ios/Tests/PuttingLabCoreTests/    synthetic-camera tests of the whole pipeline
../../public/putting-lab/calibration-template-a3.svg   the sheet coaches print
../../src/native/clarityPuttingLab.ts                   the page's typed bridge
../../src/modules/putting-lab/PuttingLabLauncher.tsx    the "Open Putting Lab" strip
```

**PuttingLabCore** knows nothing about cameras or screens. Feed it luma frames
and timestamps, read snapshots and strokes. Every rule in it runs on any
machine with a Swift toolchain, which is what lets it be tested properly.

**ClarityPuttingLabPlugin** is thin on purpose: it captures, hands the core a
pointer straight into each camera buffer (no copy, no colour conversion), and
draws what the core says. It measures nothing itself.

The page only opens the lab and hears back each measured putt
(`strokeMeasured`) and the session when it closes (`closed`). Nothing is saved
yet; joining putts to players, lessons and reports comes after the numbers have
been validated on a real green.

## How a session runs

1. **Template.** Lay the printed A3 template on the green, ball off the black
   disc. The detector finds its eight black marks by shape and relative size,
   uses the disc and the aim dot to predict where the rest must be, and solves
   a homography (camera pixels -> green millimetres) from all eight. It waits
   for six steady sightings and averages them. Core Motion only warns if the
   camera is badly tilted; it never defines the measurement frame.
2. **Ball.** Put a ball on the disc. Its centre confirms the origin and its
   measured diameter checks the print scale.
3. **Putter.** Set the face square on the printed line, touching the ball, and
   hold still. The lab learns this putter: heel-to-toe span, where its visible
   edge sits relative to the true face line, its texture, and any stickers.
4. **Lift the template.** The calibration stays: the world plane, the ball
   spot and the putter's shape are all remembered.
5. **Putt.** Ready -> putt -> Face / Path / Start with the trace -> Ready.

## Coordinates

```
image pixels --(homography)--> world plane (mm) --(aim rotation)--> target plane (mm)
```

- World: ball at the origin, +y down the physical calibration line, +x right.
- Every angle is a direction angle: **positive = right** of the reference line.
  Face, path and start all use it, so face-to-path is face minus path.
- The virtual aim rotates the target frame about the ball. Changing it never
  recalibrates anything, and every stored putt is re-read against the new aim
  (samples are stored in world coordinates for exactly this reason).

## Tracking the putter

Three lightweight witnesses, none of which owns the truth:

| Source | Sees | Notes |
| --- | --- | --- |
| markers | 3 sticker centroids -> rigid fit | Optional. "Enhanced tracking". Stickers need not be placed precisely: calibration measures where they are. |
| features | texture on the head, matched against how calibration says it *should look* at the predicted pose | Drift-free: always compared with the calibration image, warped to the prediction. |
| edge | the face's top edge across the face, plus the toe end | Works on a completely plain putter. |

`PutterTracker` runs a constant-velocity Kalman filter over the face centre and
face angle and folds each reading in by its own confidence and precision.
A reading far from the prediction is refused, unless confident readings keep
disagreeing with it for several frames, in which case the track re-anchors
(`PuttingObservationFusion`). A lost putter is looked for only where the golfer
will set it: behind the ball.

Search is always confined to where the prediction says the putter or ball is.
On this project's test machine the core takes about 0.4 ms per frame; the
camera drops frames rather than queue them if analysis ever falls behind.

## Impact and the numbers

- **Impact time**: the ball's departure extrapolated back to zero, cross-checked
  against the face reaching the back of the ball. Neither relies on the one
  blurred frame nearest contact.
- **Face and path at impact**: quadratic fits through the frames either side of
  impact, read at the impact instant.
- **Start line and speed**: a line fit and a curve fit to the first ~300 mm of
  roll, once the ball is clear of the face.
- Also: face-to-path, strike point across the face, face rotation from address
  and its rate at impact, side-to-side movement, backswing length and timing,
  digital gates, and consistency (mean and spread) across the session.

Each value carries a confidence; low-confidence values are shown faint.

## Camera

- The fastest format the back camera offers (240 fps where available, else
  120), 1280-1920 px wide, bi-planar YCbCr so luma is plane 0.
- Frames stay in sensor orientation; the overlay converts through the preview
  layer, which knows the rotation and letterboxing.
- About a second after start, focus and white balance are locked and exposure
  is switched to a short shutter (1/1000 s) with ISO raised to match, so a
  putter at 2 m/s blurs about 2 mm and every frame is measured under the same
  brightness.
- **Camera moved**: tilt is read from gravity and rotation is counted only
  while the phone is actually turning, so sensor drift on a still tripod never
  trips it but a knock does. A move pauses measurement until recalibrated.

## Validation

Accuracy is a number someone measured, not a claim. The lab's **Validate**
menu records readings against printed geometry:

- Face on the square line, or on the printed +/-1 and +/-2 degree lines (each
  still hold of the putter is one reading).
- Balls rolled along the calibration line (each putt is one reading).

It reports bias, spread and worst error, and sends the run to the page
(`validationFinished`). Validation is against the physical line, whatever the
aim is set to.

### What the synthetic tests show (and do not)

`PuttingLabCoreTests` renders frames through a real pinhole camera (1300 mm
up, tilted 6 degrees, turned 3 degrees, sensor noise, anti-aliased edges), runs
the full calibration flow, lifts the template and plays putts with known truth.
Current results:

| Case | Face | Path | Start | Speed | Impact time |
| --- | --- | --- | --- | --- | --- |
| Markerless, textured head, 240 fps | 0.02° | 0.07° | < 0.01° | < 0.1% | < 0.1 ms |
| Stickers, 240 fps | 0.04° | 0.07° | < 0.01° | < 0.1% | < 0.1 ms |
| Firm putt, 120 fps | < 0.01° | 0.06° | < 0.01° | < 0.1% | < 0.1 ms |
| Plain black head (edge only) | 0.03° | 0.10° | < 0.01° | < 0.1% | < 0.1 ms |

These prove the geometry, the pipeline and the maths. They do **not** prove
real-world accuracy: the synthetic green is flat and evenly lit, the putter's
top is drawn on the ground plane (a real one is ~25 mm above it), and there is
no grass texture, shadow or motion blur beyond the renderer's anti-aliasing.
Use the Validate mode on a real green before quoting any accuracy.

## Known limits of this first version

- The putter's top and the ball's centre sit above the green; the homography
  maps them as if they were on it. With the camera overhead this scales
  positions by roughly 2% about the point below the lens and leaves angles
  essentially unchanged. Speeds read correspondingly low by that ~2%.
  Correcting it needs the camera height (from intrinsics); not done yet.
- Markers are found by brightness only (bright stickers on a dark head, or the
  reverse via calibration). Coloured-sticker detection is a later addition.
- Three-dot balls: the dots are detected and stored with each ball sample, but
  nothing uses them yet. The structure is there for identity and spin later.
- The native screen's wording is English only.

## Running the tests

With Xcode, or any Swift 5.9+ toolchain (Linux works; the Capacitor target is
left out there):

```bash
cd native/clarity-putting-lab
swift test -c release -Xswiftc -enable-testing
```

Release mode because the renderer draws a few thousand frames. If the template
layout changes, regenerate the printable sheet with
`PUTTING_LAB_WRITE_TEMPLATE=1 swift test -c release -Xswiftc -enable-testing --filter testCommittedTemplate`.

## Running on a phone

```bash
cd booking-app
npm install
npm run ios        # cap sync ios + open Xcode
```

Then run on a device (the simulator has no camera). Print the template at
actual size from `/putting-lab/calibration-template-a3.svg` and check its
100 mm scale bar.
