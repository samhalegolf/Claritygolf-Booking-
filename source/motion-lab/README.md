# Clarity Motion Lab

An experimental 3D motion-analysis environment, deliberately insulated from
the production booking app.

```
VIDEO  ->  GOOGLE / MEDIAPIPE  ->  CLARITY MOTION LAYER  ->  3D SPACE
            (observes)              (reconstructs)           (renders)
```

## The rule

**The 3D Space never consumes Google / MediaPipe data directly.** It consumes
`ClarityFrame` and nothing else.

That is not a convention here, it is a test. `src/contracts/boundary.test.ts`
reads every import in `space3d/` and fails the build if one resolves into
`observe/` — including a type-only import, because importing a detector's
types into the renderer is the first step of importing its data.

If the renderer needs a fact the detector knows, the answer is to add that
fact to `ClarityFrame`, so the Motion Layer has to state it explicitly and
every consumer sees the same thing.

## Layers

| Directory | Owns | May import |
| --- | --- | --- |
| `contracts/` | `ClarityFrame`, joints, units, maths | nothing |
| `observe/` | detector output, as observed | `contracts/` |
| `motion/` | the Clarity Motion Layer | `contracts/`, `observe/` |
| `space3d/` | the 3D renderer | `contracts/`, `three`, `react` |
| `synthetic/` | fixture ClarityFrames | `contracts/`, `motion/` |
| `app/` | the lab shell | anything above |

`synthetic/` may use `motion/` so the fixture exercises the real mass model
and confidence roll-up rather than a second copy free to drift from them. It
may not use `observe/`: its whole purpose is proving the contract without a
detector.

## Insulation from the booking app

- Own Vite config (`vite.lab.config.ts`), own `index.html`, own entry.
- Own `tsconfig.json`. The root tsconfig's `include` is `["src"]`, so
  `npm run typecheck` and `npm run build` do not compile the lab.
- Imports nothing from `../src`. Code arrived by one-way copy.
- `three` is a **devDependency**. If it ever appears in `dist/` or
  `dist-app/`, something has imported across the wall.
- Output is `dist-lab/`, which is nobody's `webDir` and is not deployed.

## Commands

```bash
npm run dev:lab         # http://localhost:5180
npm run test:lab        # node test runner via tsx
npm run typecheck:lab
npm run build:lab
```

## Where the build is

**Build 1 — the 3D Space. Done.** Skeleton, persistent thorax and pelvis
bodies, CBP and its trail, mass and support, playback, scrubbing, four camera
presets, provenance colouring and a confidence ribbon — all driven by
synthetic ClarityFrames, with no detector involved.

The scenario picker exists to prove the honesty layers while the true answer
is still known. Once real video is involved there is no ground truth to
compare against, so "does a dropout look like a dropout?" has to be answered
now.

**Build 2 — the observation engine. Done.** MediaPipe Pose in a classic
worker, its output relabelled into Clarity's vocabulary and anchored into
world space, with a raw overlay that stays honest about what the detector
could actually see. Measured: 1.6s to initialise, 23ms per 1080p frame.

**Build 3 — the Clarity Motion Layer. Done.** Persistent body model measured
from this golfer, outlier rejection by second difference, gap reconstruction
from both sides, reacquisition with connected structures as evidence,
evidence-driven smoothing, and per-structure confidence.

### Does it work?

The synthetic source runs one body three ways — ground truth, a detector with
no reconstruction, and a detector with the full Motion Layer — so the question
has a number rather than an opinion. Mean joint error against the truth:

| scenario | baseline | Motion Layer |
| --- | --- | --- |
| clean | 5.7 mm | 5.7 mm |
| pelvis dropout | 8.0 mm | 6.0 mm |
| everything at once | 33.9 mm | 5.9 mm |

The first row matters as much as the last: a reconstruction that improves bad
data by degrading good data has not improved anything.

Each stage can be switched off individually to see what it is buying. A stage
that changes nothing is not earning its place.

**Build 4 — the clubhead tracker and the CBP. Done.** A clubhead found in
pixels, lifted into 3D, and a balance point derived from the club's geometry.

### How the CBP gets from pixels to metres

| step | how |
| --- | --- |
| find the clubhead | the fastest-moving thing in the frame. Three-frame differencing tells where it IS from where it WAS. |
| calibrate the camera | from the body itself — every observed joint carries its 3D position and the pixel it was seen at. Recovers the camera's position to 2cm. |
| measure the club | the perpendicular distance from the hands to a detection's viewing ray is a hard LOWER BOUND on the club's length. The true length is the largest such bound over the swing. |
| place the clubhead | where the ray meets a sphere of that length around the hands. |
| derive the CBP | from that geometry — never from the detected pixels. |

Nothing is calibrated, no club is assumed, and no depth sensor is involved.

Measured: clubhead found to within **8 pixels** on a 480px frame; median CBP
error **7–9mm** end to end for cameras 45°–90° off face-on, including down the
line.

### The known limit

Square to the camera the club swings mostly toward and away from the lens,
and the two candidate depths leave the wrist angle identical to within a
degree. There the clubhead's **image position stays correct** and its
**depth can be several hundred millimetres wrong** — precisely the error a
face-on viewer cannot see and a 3D view can. `depthEvidence` reports it and
the club's confidence falls to about 0.15.

There is exactly one golf-specific prior in the reconstruction, and it is
named as such: a swing brings the clubhead to the ground. It is consulted
only where the hard physics is silent, weighted below a real anatomical
violation, and kept out of `depthEvidence`.

## What the confidence score means

How much reconstruction and assumption a frame required. **Not** whether the
golf movement looks normal — a bizarre but cleanly observed swing must score
high. No value is defined as good or bad yet; the point of the first version
is to look at real swings and find out what useful ranges are.

The overall score is a **body** score. Club confidence is reported beside it
and does not drag it down, because a poor club track should not invalidate an
otherwise strong body reconstruction.

## What the mass model does not claim

It is an estimate from video, not force-plate data. No pressure is measured,
no rotational or torsional force is modelled, and nothing infers body
composition. The mass pot is a fixed 100 virtual units; absolute body weight
is never required or estimated.

The upper mass map and the support estimate are separate on purpose. Upper
mass may land outside the feet — often does. Support may not: it is
constrained into the polygon of whichever foot points are actually on the
ground, so a lifting heel genuinely shrinks it.
