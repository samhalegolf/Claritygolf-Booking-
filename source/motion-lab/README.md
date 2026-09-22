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

## The wall is one-way

The booking app mounts the lab. Its video workspace
(`src/modules/video-analysis/VideoWorkspace.tsx`) lazy-loads
`src/embed/MotionLabView` behind a "3D motion" button, hands it the clip
already on screen, and lets it detect, reconstruct and render in an overlay.
The root `vite.config.ts` runs the lab's two plugins (`vite.plugins.ts`) so
the pose worker and MediaPipe's WASM are served in dev and emitted into
`dist/` on build. `three` therefore **does** appear in `dist/` -- in the
lab's own chunk, downloaded only when a coach opens 3D motion.

What has not changed is the other direction:

- The lab imports nothing from `../src`. Code arrived by one-way copy, and
  `contracts/boundary.test.ts` fails if any file under `src/` here resolves an
  import above it.
- Own Vite config (`vite.lab.config.ts`), own `index.html`, own entry, own
  `tsconfig.json`. `npm run dev:lab` is unchanged and the synthetic source
  lives only there.
- Every class in `app/lab.css` carries the `lab-` prefix and hangs off `.lab`;
  nothing in it touches `:root`, `body` or a bare element, so loading it inside
  the workspace restyles nothing of the workspace's. `standalone.css` holds the
  page-level rules the lab page needs and only `main.tsx` imports it.
- The native build is out for now. `vite.app.config.ts` does not run the
  plugins (the WASM would add 34 MB to the app bundle) and the workspace hides
  the button when `NATIVE` is true.
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

## Camera pitch, and the one thing it cannot corrupt

Levelling from the stance line fixes the **roll** — the tilt around the lens
axis — because a line between two flat feet is horizontal. One line gives one
constraint, so the **pitch**, the tilt up or down, is left untouched.

It is not a small residue. A pitch of θ adds `h·tan θ` to the fore-aft
position of everything at height h: at 2° that is 2mm at the ankle, 33mm at
the hip, 51mm at the shoulder. Every heel-versus-toe signal inherits it.

**The naive fix does not work.** A camera pitch is exactly linear in height,
so regressing fore-aft position on height looks like it should recover it. It
does not, because a golfer is not a plumb line: address puts the shoulders and
head well forward of the ankles, and those are also the highest points, so the
*posture* correlates with height by itself. This fixture, filmed dead level,
regresses to **10.7°**. Treating that as camera tilt would rotate a golfer's
genuine address out of the data.

**What works is the shape, not the slope.** A pitch adds a straight line and
nothing else, so whatever is left after the best straight line is removed
cannot contain any pitch. Hips back against shoulders forward is a *bend*, not
a slope, so it survives intact.

| reading | 5° of camera pitch moves it | a real 60mm squat moves it |
| --- | --- | --- |
| hips relative to the ankles | **76 mm** — sign flips | 60 mm |
| hip bend off the ankle→shoulder line | 2.8 mm | **51 mm** |
| knee bend off the same line | 0.4 mm | **34 mm** |

The first row is the failure: filmed on a 5° pitch, a golfer genuinely sitting
60mm back reads as 13mm *forward*. The other two are `foreAft.ts`.

The invariance is exact for the shear a pitch applies and near-exact for the
rotation it really is — 0.7mm per degree on the hip reading against 15mm per
degree taken naively. `apparentLeanDeg` is where the pitch still lives, and is
named for what it is: camera plus golfer, inseparable from one posture.
`linearFractionUnit` says how much of a profile a tilt alone could account for,
so a body shaped like a plumb line declines to answer rather than reporting
zero.

## The fixture used to be a mirror image of a human

Found the first time a real clip was run, which is the only way it could have
been found.

With `+X` from the left foot to the right and `+Y` up, a real person's toes
point along **−(X × Y)**. The mnemonic is East-North-Up: E × N = Up, so
**E × U = South** — right cross up points *behind* you. The fixture was built
the other way and `units.ts` documented the same mistake, so the two agreed
with each other and the whole suite passed over a body no human could have.

| | facing | left foot | `dot(R×U, toes)` |
| --- | --- | --- | --- |
| real clip, via MediaPipe | +Z | +X | **−0.996** |
| fixture, before | +Z | −X | **+0.993** |
| fixture, after | −Z | −X | **−0.993** |

**What it cost.** Every signal whose meaning depends on the fore-aft *sign*
came out backwards on real video while looking perfect on the fixture: the
direction `hipSetBackM` calls "behind", the sign of `apparentLeanDeg`, and
worst, the sign of the camera-pitch correction — which would have **doubled**
the error it exists to remove.

**The fix.** The fixture is reflected in Z (not X: the anchor *defines* +X as
left-to-right, so every anchored body has its left on −X, and reflecting in X
would leave the round trip comparing a body against its own 180° rotation).
Rotations need more than a sign flip — conjugating by `diag(1,1,−1)` turns a
quaternion `(x,y,z,w)` into `(−x,−y,z,w)`.

Two viewpoints moved with it, since a camera on +Z was now filming the back of
the golfer's head while the name said face-on: the synthetic detector's camera
and the club test's `cameraAt`.

**So it cannot come back:** `foreAft.toeDirection` now *measures* which way the
toes point from the feet instead of assuming it from the axis, so the pipeline
is correct whichever convention a detector uses; and a test asserts
`dot(R×U, toes) < −0.8` — the remaining degree of freedom that "left is on −X"
could never check, because the anchor makes that true by construction.

## The falling-over boundary

"Where is the mass between heel and toe" is the most pitch-sensitive number
here: the mass centre is ~920mm up and the foot is ~265mm long, so **one
degree of camera pitch slides the reading 16mm** — 6% of the foot. Measured on
the fixture, 5° of pitch moved it from 77% of the foot to 110%, while a golfer
genuinely sitting 60mm back moved it 7%. The reading is about **five times
more sensitive to the tripod than to the golfer**.

Levelling from the stance line fixes the roll and is **blind to the pitch** — a
rotation about that same line leaves the line exactly where it was.

> Flatness is judged as a **spread against the clip's own flattest frames**, not
> against an absolute tolerance. The absolute version failed silently on exactly
> the clips that needed it: a pitch of θ raises the toes above the heels by
> `footLength · sin θ` — 28mm at 8° on a 200mm foot — so past that, every frame
> looked like a heel lift, nothing passed, and the roll was reported as **zero
> with no flag**. `gravityTiltIsMeasured` now separates a measured zero from an
> unmeasurable one. Measured roll matches the truth exactly from 0° to 20° of
> pitch at every yaw tested.
 One thing
does see it: the golfer's own balance.

A person standing on both feet has their mass over those feet. Past the toes or
behind the heels they are not standing, they are falling. That edge is the
**falling-over boundary**, and it is physics rather than technique — it says
nothing about how anyone should address the ball, only that they were still on
their feet while being filmed.

So a reading past the toes is not surprising, it is *impossible*, and the
smallest pitch that brings the mass back onto the boundary is a hard lower
bound on the camera's tilt. Each planted frame gives one interval; they
intersect; the angle applied is the **smallest pitch inside the result**, which
is usually zero.

| true pitch | raw reading | admissible range | applied | mean joint error |
| --- | --- | --- | --- | --- |
| 0° | 0.76 | −3.8° … 11.3° | none | 5.7 → 5.7 mm |
| 2° | 0.89 | −1.7° … 13.4° | none | 30.3 → 30.3 mm |
| 5° | **1.09** | 1.6° … 16.5° | **1.60°** | **73.3 → 50.4 mm** |
| 10° | **1.42** | 7.2° … 21.6° | **7.19°** | **145.2 → 41.9 mm** |

The interval always contains the truth — that is the property the tests pin
down, and it is why the correction can never invent a camera angle. Two degrees
is unprovable because 89% of the foot, while ugly, is possible; saying so is
the honest answer, and the bodies then come back bit-for-bit identical.

The last column is what justifies the mechanism: the correction makes the
reconstruction **measurably closer to the known body**, not merely tidier on
the readout.

### A floor, not a fix

Five degrees of pitch is only caught out by 1.6, because the reading has to
travel all the way past the toes before it becomes impossible at all. What
comes back is a scene that is no longer impossible — it is not thereby right,
and `anchor.pitchCorrectionDeg` is on the record so nobody has to guess whether
something was done to it.

The boundary also only catches a tilt pushing the golfer **toward an edge they
were already near**. This fixture stands at 76% of its foot, so forward tilt is
caught quickly and backward tilt has most of the foot to cross first — 10°
backwards goes entirely undetected. A golfer nearer mid-foot would be caught
about equally either way. There is a test holding that limit visible.

### How it runs

The evidence for the pitch is the mass model, which needs a reconstructed body,
which needs an anchored sequence — and the anchoring is what the pitch has to go
into. The dependency genuinely is a loop, so `reconstructLevelled` runs it as
one: reconstruct, ask the boundary, re-anchor with the answer, reconstruct
again. **Two passes, never three** — the correction puts the mass on the
boundary by construction, so a second ask has nothing left to find and would
only chase detector noise around the edge of the foot. Costs about 20ms.

The angle goes in at the **anchor**, not onto the finished frames: rotating the
output would leave the feet hanging off the ground, since the grounding, contact
alignment and origin were all computed in the old frame.

The baseline/passthrough view is deliberately **not** levelled. Its job is to
show what arrives with nothing done to it.

**Shape.** The mass centre is a weighted sum of body points, so it splits the
same way the profile does: the bend part is pitch-free. Over 10° of pitch the
raw reading moves ~175mm and `bendFractionUnit` moves ~10mm. A real squat moves
the bend; a camera pitch does not.

**Where it shows up.** The verdict rides on `ClaritySequence.massSanity` and the
applied angle on `anchor.pitchCorrectionDeg` — both clip-level, because a
camera's pitch is one number for a whole clip. The mass panel reads both, and
says in as many words when a scene has been rotated. The check runs only over
frames whose **feet the detector actually saw**: measuring an invented mass
against an invented foot would produce a number with no evidence in it that
looked exactly like a real one.

### The band that would make this sharp, and why it is not the default

Narrowing "over the feet" to "near mid-foot" tightens the interval from ~15°
to under 4°. It is almost certainly true of real people — and it is *false of
this fixture*, whose address leans the spine forward without pushing the hips
back, putting its mass genuinely at 76% of the foot. Asked to force that into
a mid-foot band, the check proves 2° of tilt on a level camera. There is a test
that fails if anyone tightens the default before real footage says where people
actually stand.

## The standing shot

The falling-over boundary is free and always available, but it only ever gives
a **lower bound** — 8° of tilt caught out by 4.9°, and a clip whose mass never
nears the edge of the foot proves nothing at all.

Two seconds of the golfer **standing still**, filmed from the same camera,
collapses it. At address the fore-aft profile carries a huge posture term (10.7°
on a level camera); standing up, the body is close to a plumb line, so its slope
is close to the camera's.

| scenario | applied pitch | mean joint error |
| --- | --- | --- |
| Clean, level camera | — | 5.7 mm |
| 8° tilt, boundary only | −4.9° | 45.5 mm |
| 8° tilt **+ standing shot** | **−8.1°** | **6.1 mm** |
| 8° tilt + a crouched standing shot | −4.9° (refused, fell back) | 45.5 mm |

The standing shot returns the reconstruction to the accuracy it has on a level
camera. All four rows are scenarios in the lab.

### Two estimators, bracketed rather than averaged

The raw slope is the pitch plus however far from vertical they stood. That
residual can be removed *if* the only thing they did was tilt at the hip: an
upright body rotated by φ about the hip has a profile slope of exactly
`hipBend / hipHeight`, and `hipBend` is the pitch-free residual `foreAft`
already measures. Exact to a hundredth of a degree from 0° to 15° of spine tilt.

Exact for a narrow reason, though — that model has **one** posture degree of
freedom. Push the hips *back*, a translation rather than a rotation, and the
bend grows while the slope barely moves, so subtracting it over-corrects: hips
60mm back makes a level camera read **−3.9°**. And pushing the hips back is the
main thing a golfer's lower body does.

The two therefore fail in opposite directions, so what is reported is the
**bracket between them**, widened by a noise floor. Wide exactly when the pose
was ambiguous, narrow when the golfer did what they were asked. A bend over
50mm is refused outright, with the reason.

### The foot model: direction from the feet, length from the golfer

A foot points almost entirely along the **depth** axis — a detector's weakest —
and face-on it is foreshortened on top of that. On a real face-on clip
MediaPipe measured heel-to-toe as **119 mm**, where anatomy puts an adult's
foot near 265 mm. Used as the support polygon that halves the base of support
and doubles every fraction computed against it.

So the feet give the **direction** (measured, never assumed — see the mirror
above) and the golfer's own stature gives the **length**, at 0.152 × height —
the same population ratio the fixture is built from, named as an assumption
rather than buried.

`footScaleUnit` reports measured ÷ expected: **0.98** on clean synthetic data,
**0.47** on a real face-on clip, **0.51** down the line.

That third number corrected the second. The 0.47 looked like depth compression —
the foot points along depth face-on — but down the line the foot lies *across*
the image and it still read 0.51. Measured against the tibia in the same frames
(both in the image plane, so neither is foreshortened): the **image** landmarks
put the foot at 0.50 of the tibia where anatomy says 0.62; the **world**
landmarks put it at 0.32. The detector simply builds a smaller foot than the
body it is attached to, whichever way the camera points. So `footScaleUnit`
justifies deriving `footSpanM` from stature — it does not diagnose a clip's
depth.

What it bought on that clip:

| | before | after |
| --- | --- | --- |
| support polygon | 119 mm | **252 mm** |
| mass along foot | 221% | **78%** |
| verdict | `irreconcilable` | **`corrected`, +4.2° applied** |
| confidence | 0 | **65** |

### What the down-the-line clip showed

The two views are complementary, and the numbers say so plainly.

| | face-on | down the line |
| --- | --- | --- |
| stance width (along the stance line) | **0.476 m** ✓ | **0.24 m** — halved |
| heel–toe mass verdict | `corrected`, confidence 65 | `corrected`, confidence 61 |
| `footScaleUnit` | 0.47 | 0.51 — unchanged, so not a depth signal |

Stance width **is** view-dependent, and it is the honest evidence that this
detector's depth axis is compressed by roughly half: face-on the stance lies
across the image and measures right; down the line it lies along depth and
halves.

## The fixture is built from a detector's skeleton, not an anatomy textbook

Three defects reached real footage because the fixture built an idealised body
and the pipeline was graded against it — a support polygon halved by taking the
landmark span for a whole foot, contact that no heel ever satisfied, and a
levelling reference that assumed heel and toe sit at the same height. **Every
test here passed throughout.** They share one cause, so the fixture now mimics
where a detector actually puts its landmarks.

Measured across three clips and two golfers, as fractions of stature, against
what the fixture used to assume:

| segment | measured | fixture (old) | ratio |
| --- | --- | --- | --- |
| femur | 0.249 | 0.245 | 1.02 |
| forearm | 0.140 | 0.146 | 0.96 |
| tibia | 0.224 | 0.246 | 0.91 |
| hip width | 0.131 | 0.110 | 1.19 |
| shoulder width | 0.175 | 0.230 | 0.76 |
| upper arm | 0.132 | 0.186 | 0.71 |
| **foot** | **0.075** | **0.152** | **0.49** |

**Only the foot is changed.** The rest are landmark-placement differences — a
shoulder landmark is the joint centre, not the acromion — and nothing in the
pipeline compares those segments against a population figure the way the foot
is compared against the ground and against `0.152 × height`. They are recorded
in `proportions.ts` rather than applied, because acting on the uncertain ones
(the 0.71 upper arm would shorten the golfer's reach by 18%) would break a
tuned fixture on a measurement taken from address poses with bent arms.

The foot now has a **sole** and **landmarks on it**, kept apart. The sole is
anatomical and does the physics — planted toe, heel pivoting about it, bone
lengths holding. The landmarks are what a detector reports of it: the heel
rides `0.028 × height` up the calcaneus, the toe sits `0.46` along the sole at
the ball. Together those reproduce both the shortened span and the ~22° slope
real clips show.

| | fixture before | fixture now | face-on | dtl-a | dtl-b |
| --- | --- | --- | --- | --- | --- |
| heel rest height | 0 mm | **51 mm** | 56 mm | 28 mm | 15 mm |
| `footScaleUnit` | 0.98 | **0.45** | 0.47 | 0.53 | 0.36 |
| mean polygon points | 4.00 | **3.30** | 3.15 | 2.89 | 2.62 |

One consequence worth seeing: the trail toe no longer stays at exactly zero
through the finish. The landmark is at the ball and the foot pivots about its
tip, so rolling up onto the toes lifts the ball off the floor — which is what a
finish looks like. The test now asserts the foot *rolls* (heel rises much
further than the ball) rather than asserting a zero that was only true of an
idealised foot.

### The detector's heel is not on the floor

A detector's **HEEL landmark sits up on the calcaneus**; its toe landmark sits
at the ball, near the ground. Measured on two real clips, planted heels rested
**15–65 mm** up and planted toes within a few millimetres of nothing.

Contact was tested as "within 35 mm of the ground", so on real footage **the
heels never counted as touching it**:

| | face-on | down the line |
| --- | --- | --- |
| frames with all four points in contact | **0 / 81** | **0 / 72** |

Every frame reported the two toes and nothing else — which makes the support
polygon a **line**. The golfer was modelled as balancing on their toe line for
the whole swing, and the foot-load split and support centre were computed from
that.

Contact is now measured against each landmark's **own resting height**, taken
from the clip (a low percentile per landmark is its resting height), so nothing
depends on a particular detector's skeleton. The fixture has all four on the
sole, which is why this survived until there was real video.

| | before | after (face-on) | after (down the line) |
| --- | --- | --- | --- |
| mean polygon points | 2.00 | **3.16** | **2.79** |
| four-point frames | 0 | 34 | 26 |
| foot load split | — | 47 / 53 | 55 / 47 |

The anchor's own contact test still works against the ground, deliberately: its
job is to pick points that do not *move* so frames can be aligned, and that is
the toes — a resting heel is about to lift.

### Down the line, the stance line gives the camera's pitch

The line between the ankles is horizontal, so its drop down the image says the
world is not level. The anchor reads that as `atan2(dy, dx)` — which needs the
line to have width **across** the image. Square to the stance it has none, so
the anchor declines.

The drop is still there. What is missing is only a baseline to divide it by,
and the golfer's stature supplies one: `asin(drop / stanceWidth)`. Validated
against known tilts: at yaw 90, 4° reads 3.7 and 8° reads 7.7, and injecting
roll moves it by under half a degree.

**Three rotations get confused here, so they are worth naming together:**

| | turns about | undoes |
| --- | --- | --- |
| the levelling | the camera's **depth** axis | a camera roll |
| `pitchCorrectionDeg` | the **stance line** | a golfer leaning fore-aft |
| `cameraPitchDeg` | the camera's **horizontal** | a camera pitch |

Square to the stance, a camera pitch maps to the world's fore-aft axis — which
is **neither of the other two**. Both were tried first: each turned a 90mm
error into 120–123mm, **in either sign**, which is what a wrong axis looks like
rather than a wrong direction. Given its own axis:

| injected tilt | plain | corrected |
| --- | --- | --- |
| 6° | 90 mm | **7 mm** |
| 10° | 150 mm | **7 mm** |
| 15° | 223 mm | **7 mm** |

On real footage the two down-the-line clips measure their own cameras at
**−6.7° ± 2.2** and **−4.1° ± 1.2**, and the face-on clip declines (5% along
depth) and keeps using the image, which needs no assumed width and is the
better number where it exists.

The two views are exact complements: **face-on gives the roll and cannot give
the camera's pitch; down the line gives the camera's pitch and cannot give the
roll.**

### Levelling down the line: what still cannot be done

`gravityTiltDeg` is measured from the ankle-to-ankle line, and square to the
stance that line points **at the camera** — 99% along depth on the real clip.
It then carries no information about the roll at all (turning the image about
the lens axis cannot move a vector lying along it) and what it *does* carry is
the camera's **pitch**, which a rotation about x tips straight into its y. So
the old estimator wasn't returning a noisy roll; it returned a different angle
and corrected the world by it — **13.1°, of which none was roll.**

Two fixes, one of which failed and is worth recording:

**The angle is now read from the image plane alone** — `atan2(dy, dx)`, never
the 3D length. A roll φ turns a horizontal vector's in-plane part from `(a, 0)`
to `(a cos φ, a sin φ)`, so depth never enters and the compression that was
inflating the old reading cannot reach it. The extent that gates and weights
each reference is the **horizontal** part only: 20° of pitch square-on gives
the stance line a large *vertical* image extent, and every millimetre of it is
pitch.

**The foot line does not work.** Each foot's heel-to-toe line should have been
the perfect second reference — horizontal, square to the stance, across the
image exactly when the stance points away. It was built, and real footage
killed it: a detector's heel landmark sits up on the calcaneus and its toe
landmark sits at the ball, so the line **slopes**. Measured on two clips, the
toe came out **45–69 mm below the heel** over a foot 120 mm long — about 25°,
on every frame of both. The fixture puts both on the ground, which is why the
idea survived until there was real video to try it on.

So with no reference that is both horizontal and across the image, the **roll**
is declined — the camera's pitch is still recovered, by the section above. On
the real down-the-line clip `gravityTiltIsMeasured` is **false** and no roll is
applied — and the heel–toe reading it had been
corrupting comes back to **47% of foot** with confidence 0.67, where the bogus
roll had put it at −7%.

The stance line is used for as long as it has 150 mm of horizontal image
extent, which is a length rather than a yaw — so a wide stance survives further
round than a narrow one, and that falls out instead of being special-cased.

### In the video path

Two clips, **detected once each**. A swing, and optionally a standing shot,
which can arrive in either order and either of which can be replaced or
dropped. Detection is the expensive step (tens of ms per frame); reconstruction
is not — so adding a standing shot re-levels a swing already loaded **without
detecting it again**, and dropping one restores the un-calibrated result
exactly rather than approximately.

The decision logic lives in `app/videoSequences.ts` rather than in the hook,
because a React hook cannot be tested by this project's runner and the part
that can actually be wrong should be. What is left in `useVideoObservation` is
state plumbing. The club search is switched off for the standing clip — there
is no swing in it to find a clubhead in.

The baseline shown beside the reconstruction is **never** levelled. Its job is
to show what arrives with nothing done to it, and correcting it too would make
the side-by-side flatter the Motion Layer. There is a test.

### The blind spot, on the record

After the calibration is applied, the boundary is asked again; anything it
*still* forces means the standing shot under-corrected, and physics wins
(`agreement: "boundary-forced-more"`).

That cross-check is **one-sided**. It cannot catch a shot that corrected too
*much*, because over-correcting drags the mass toward the heels — deeper inside
the foot, where nothing is violated. Measured: a standing shot filmed at 10°
applied to a level swing gives 152mm of error against 5.7mm for doing nothing,
and every check passes. There is no geometric fix; the camera genuinely moved
and no arrangement of the pixels says so. `boundaryRangeDeg` is the one hint —
a calibration pressed against the edge of what the swing itself admits is one to
distrust. Beyond that it is operational: film both from the same place. There is
a test holding this limit visible.

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
