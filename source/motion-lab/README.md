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

**Build 2 — the observation engine.** MediaPipe Pose in a worker, raw
landmarks cached, a debug overlay on the source video that stays honest about
what the detector could actually see.

**Build 3 — the Clarity Motion Layer.** The major piece: persistent body
model, connected geometry, objective gap reconstruction, reacquisition,
smoothing driven by evidence rather than by how ugly the movement looks, and
reconstruction confidence.

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
