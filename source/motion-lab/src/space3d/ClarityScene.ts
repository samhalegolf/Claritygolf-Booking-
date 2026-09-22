/**
 * The 3D Space.
 *
 * Consumes ClarityFrame and nothing else -- no landmark indices reach this
 * file, and `contracts/boundary.test.ts` fails the build if one ever does.
 *
 * WHAT THIS IS FOR, per the plan: relative movement, spatial understanding,
 * seeing the motion from angles the original video did not have, explanation,
 * pattern discovery. It is NOT pretending to be marker-based capture. The
 * honest counterpart is the video overlay, which stays close to what the
 * detector actually saw; this view shows the reconstructed journey.
 *
 * Every dynamic object is allocated once and mutated per frame. Rebuilding
 * geometry each frame would work fine at 144 frames and then fall over on a
 * long clip -- and worse, the garbage it made would show up as stutter that
 * looks like a tracking problem.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  GridHelper,
  Group,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Raycaster,
  RingGeometry,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";

import type { ClarityFrame, ClarityJoint, ClaritySequence, Vec3 } from "../contracts";
import { CLARITY_BONES, CLARITY_JOINTS } from "../contracts";
import { CameraRig, type CameraPreset } from "./cameraRig";
import type { SceneLayers } from "./layers";
import { CBP_RADIUS_M, JOINT_RADIUS_M, PALETTE, PROVENANCE_COLOURS } from "./palette";

/** Largest support polygon we preallocate for. Four foot points can only hull to four. */
const MAX_SUPPORT_POINTS = 8;

const toVector = (v: Vec3, out: Vector3) => out.set(v[0], v[1], v[2]);

export interface SceneSubject {
  readonly sequence: ClaritySequence;
  /** Where the ball sits, if known. Reference geometry only. */
  readonly ballPosition?: Vec3;
}

/**
 * What a click in the 3D Space landed on. Only things that are drawn can be
 * picked, so a hidden layer cannot be hit.
 */
export type ScenePick =
  | { readonly kind: "joint"; readonly joint: ClarityJoint }
  | { readonly kind: "clubHead" }
  | { readonly kind: "cbp" }
  | { readonly kind: "upperMass" }
  | { readonly kind: "upperMassGround" }
  | { readonly kind: "support" }
  | { readonly kind: "ball" };

export class ClarityScene {
  readonly rig: CameraRig;
  private readonly raycaster = new Raycaster();
  private readonly pointerNdc = new Vector2();

  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();

  private readonly staticGroup = new Group();
  private readonly bodyGroup = new Group();

  private readonly boneLines: LineSegments;
  private readonly bonePositions: BufferAttribute;
  private readonly boneColours: BufferAttribute;

  private readonly jointMarkers: InstancedMesh;

  private readonly thoraxBox: Mesh;
  private readonly pelvisBox: Mesh;

  private readonly clubLine: Line;
  private readonly clubPositions: BufferAttribute;
  private readonly clubHeadMarker: Mesh;
  private readonly cbpMarker: Mesh;

  private trailPast: Line | null = null;
  private trailFuture: Line | null = null;
  private trailPositions: BufferAttribute | null = null;

  private readonly massCloud: InstancedMesh;
  private readonly upperMassMarker: Mesh;
  private readonly upperMassGroundRing: Mesh;
  private readonly upperMassDrop: Line;
  private readonly upperMassDropPositions: BufferAttribute;
  private readonly supportRing: Mesh;
  private readonly supportPolygonLine: Line;
  private readonly supportPolygonPositions: BufferAttribute;

  private ballMarker: Mesh | null = null;

  private readonly scratchVector = new Vector3();
  private readonly scratchVectorB = new Vector3();
  private readonly scratchQuat = new Quaternion();
  private readonly scratchMatrix = new Matrix4();
  private readonly scratchColour = new Color();

  private layers: SceneLayers | null = null;
  private lastFrame: ClarityFrame | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setClearColor(PALETTE.background, 1);
    this.rig = new CameraRig(1);

    this.scene.add(this.staticGroup, this.bodyGroup);
    this.buildGround();

    /* ---- skeleton ---- */

    const boneVertexCount = CLARITY_BONES.length * 2;
    this.bonePositions = new BufferAttribute(new Float32Array(boneVertexCount * 3), 3);
    this.bonePositions.setUsage(DynamicDrawUsage);
    this.boneColours = new BufferAttribute(new Float32Array(boneVertexCount * 3), 3);
    this.boneColours.setUsage(DynamicDrawUsage);

    const boneGeometry = new BufferGeometry();
    boneGeometry.setAttribute("position", this.bonePositions);
    boneGeometry.setAttribute("color", this.boneColours);
    this.boneLines = new LineSegments(
      boneGeometry,
      new LineBasicMaterial({ vertexColors: true })
    );
    // Bones are rebuilt every frame and can legitimately fly off in any
    // direction mid-reconstruction; letting three cull them against a stale
    // bounding sphere makes the body flicker out for no visible reason.
    this.boneLines.frustumCulled = false;
    this.bodyGroup.add(this.boneLines);

    this.jointMarkers = new InstancedMesh(
      new SphereGeometry(JOINT_RADIUS_M, 12, 10),
      new MeshBasicMaterial(),
      CLARITY_JOINTS.length
    );
    this.jointMarkers.frustumCulled = false;
    this.bodyGroup.add(this.jointMarkers);

    /* ---- persistent structures ---- */

    this.thoraxBox = makeWireBox(PALETTE.thorax, 0.22);
    this.pelvisBox = makeWireBox(PALETTE.pelvis, 0.26);
    this.bodyGroup.add(this.thoraxBox, this.pelvisBox);

    /* ---- club ---- */

    this.clubPositions = new BufferAttribute(new Float32Array(2 * 3), 3);
    this.clubPositions.setUsage(DynamicDrawUsage);
    const clubGeometry = new BufferGeometry();
    clubGeometry.setAttribute("position", this.clubPositions);
    this.clubLine = new Line(clubGeometry, new LineBasicMaterial({ color: PALETTE.club }));
    this.clubLine.frustumCulled = false;

    this.clubHeadMarker = new Mesh(
      new SphereGeometry(0.03, 12, 10),
      new MeshBasicMaterial({ color: PALETTE.clubhead })
    );
    this.cbpMarker = new Mesh(
      new SphereGeometry(CBP_RADIUS_M, 16, 12),
      new MeshBasicMaterial({ color: PALETTE.cbp })
    );
    this.bodyGroup.add(this.clubLine, this.clubHeadMarker, this.cbpMarker);

    /* ---- mass and support ---- */

    this.massCloud = new InstancedMesh(
      new SphereGeometry(1, 8, 6),
      new MeshBasicMaterial({ transparent: true, opacity: 0.55 }),
      32
    );
    this.massCloud.frustumCulled = false;

    this.upperMassMarker = new Mesh(
      new SphereGeometry(0.05, 16, 12),
      new MeshBasicMaterial({ color: PALETTE.upperMass, transparent: true, opacity: 0.85 })
    );
    this.upperMassGroundRing = makeGroundRing(PALETTE.upperMassGround, 0.07, 0.095);
    this.supportRing = makeGroundRing(PALETTE.supportCentre, 0.05, 0.075);

    this.upperMassDropPositions = new BufferAttribute(new Float32Array(2 * 3), 3);
    this.upperMassDropPositions.setUsage(DynamicDrawUsage);
    const dropGeometry = new BufferGeometry();
    dropGeometry.setAttribute("position", this.upperMassDropPositions);
    this.upperMassDrop = new Line(
      dropGeometry,
      new LineBasicMaterial({ color: PALETTE.upperMass, transparent: true, opacity: 0.4 })
    );
    this.upperMassDrop.frustumCulled = false;

    this.supportPolygonPositions = new BufferAttribute(
      new Float32Array(MAX_SUPPORT_POINTS * 3),
      3
    );
    this.supportPolygonPositions.setUsage(DynamicDrawUsage);
    const polygonGeometry = new BufferGeometry();
    polygonGeometry.setAttribute("position", this.supportPolygonPositions);
    this.supportPolygonLine = new Line(
      polygonGeometry,
      new LineBasicMaterial({ color: PALETTE.supportPolygon, transparent: true, opacity: 0.7 })
    );
    this.supportPolygonLine.frustumCulled = false;

    this.bodyGroup.add(
      this.massCloud,
      this.upperMassMarker,
      this.upperMassGroundRing,
      this.upperMassDrop,
      this.supportRing,
      this.supportPolygonLine
    );
  }

  private buildGround() {
    const grid = new GridHelper(8, 32, PALETTE.gridMajor, PALETTE.gridMinor);
    const material = grid.material as LineBasicMaterial;
    material.transparent = true;
    material.opacity = 0.45;
    grid.name = "ground";
    this.staticGroup.add(grid);
  }

  /* ------------------------------------------------------------------ */

  setSubject(subject: SceneSubject) {
    const { sequence, ballPosition } = subject;

    this.rig.setSubject(
      sequence.bodyModel.estimatedHeightM || 1.8,
      ballPosition ? ballPosition[2] : 0.85
    );

    this.buildTrail(sequence);

    if (this.ballMarker) {
      this.bodyGroup.remove(this.ballMarker);
      this.ballMarker.geometry.dispose();
      (this.ballMarker.material as MeshBasicMaterial).dispose();
      this.ballMarker = null;
    }
    if (ballPosition) {
      this.ballMarker = new Mesh(
        new SphereGeometry(0.0213, 12, 10),
        new MeshBasicMaterial({ color: PALETTE.ball })
      );
      toVector(ballPosition, this.ballMarker.position);
      this.bodyGroup.add(this.ballMarker);
    }
  }

  /**
   * The CBP trail.
   *
   * Two Lines share ONE position buffer: the dim one draws the whole path and
   * the bright one draws only as far as the playhead, so scrubbing reveals the
   * path rather than redrawing it. Sharing the attribute means the positions
   * exist once regardless of clip length.
   */
  private buildTrail(sequence: ClaritySequence) {
    this.disposeTrail();

    const points = sequence.frames
      .map((frame) => frame.club?.cbp)
      .filter((cbp): cbp is Vec3 => Boolean(cbp));
    if (points.length < 2) return;

    const positions = new Float32Array(points.length * 3);
    points.forEach((point, index) => {
      positions[index * 3] = point[0];
      positions[index * 3 + 1] = point[1];
      positions[index * 3 + 2] = point[2];
    });
    this.trailPositions = new BufferAttribute(positions, 3);

    const futureGeometry = new BufferGeometry();
    futureGeometry.setAttribute("position", this.trailPositions);
    this.trailFuture = new Line(
      futureGeometry,
      new LineBasicMaterial({ color: PALETTE.cbpTrailFuture, transparent: true, opacity: 0.65 })
    );
    this.trailFuture.frustumCulled = false;

    const pastGeometry = new BufferGeometry();
    pastGeometry.setAttribute("position", this.trailPositions);
    pastGeometry.setDrawRange(0, 1);
    this.trailPast = new Line(
      pastGeometry,
      new LineBasicMaterial({ color: PALETTE.cbpTrailPast })
    );
    this.trailPast.frustumCulled = false;

    this.bodyGroup.add(this.trailFuture, this.trailPast);
  }

  private disposeTrail() {
    for (const line of [this.trailPast, this.trailFuture]) {
      if (!line) continue;
      this.bodyGroup.remove(line);
      line.geometry.dispose();
      (line.material as LineBasicMaterial).dispose();
    }
    this.trailPast = null;
    this.trailFuture = null;
    this.trailPositions = null;
  }

  /* ------------------------------------------------------------------ */

  setLayers(layers: SceneLayers) {
    this.layers = layers;

    this.boneLines.visible = layers.skeleton;
    this.jointMarkers.visible = layers.joints;
    this.thoraxBox.visible = layers.thorax;
    this.pelvisBox.visible = layers.pelvis;
    this.clubLine.visible = layers.club;
    this.clubHeadMarker.visible = layers.club;
    this.cbpMarker.visible = layers.cbp;
    if (this.trailPast) this.trailPast.visible = layers.cbpTrail;
    if (this.trailFuture) this.trailFuture.visible = layers.cbpTrail;
    this.massCloud.visible = layers.massCloud;
    this.upperMassMarker.visible = layers.upperMass;
    this.upperMassGroundRing.visible = layers.upperMass;
    this.upperMassDrop.visible = layers.upperMass;
    this.supportRing.visible = layers.support;
    this.supportPolygonLine.visible = layers.support;
    this.staticGroup.visible = layers.ground;
    if (this.ballMarker) this.ballMarker.visible = layers.ball;

    // Re-running the last frame applies colouring changes without waiting for
    // playback to advance, so a toggle takes effect while paused.
    if (this.lastFrame) this.showFrame(this.lastFrame);
  }

  showFrame(frame: ClarityFrame) {
    this.lastFrame = frame;
    const colourByProvenance = this.layers?.provenanceColouring ?? true;

    /* ---- bones ---- */

    const bonePositions = this.bonePositions.array as Float32Array;
    const boneColours = this.boneColours.array as Float32Array;

    CLARITY_BONES.forEach((bone, index) => {
      const from = frame.body.joints[bone.from];
      const to = frame.body.joints[bone.to];
      const offset = index * 6;

      const fromSource = frame.provenance.joints[bone.from].source;
      const toSource = frame.provenance.joints[bone.to].source;

      // A bone touching a joint that was never located has no endpoint to be
      // drawn to. Collapsing it to a zero-length segment renders nothing,
      // which is the honest picture: an absent limb, not a limb stretched to
      // wherever the fallback position happened to be. Skipping the write
      // instead would leave last frame's bone on screen.
      if (fromSource === "missing" || toSource === "missing") {
        for (let axis = 0; axis < 3; axis += 1) {
          bonePositions[offset + axis] = from[axis];
          bonePositions[offset + 3 + axis] = from[axis];
        }
      } else {
        bonePositions[offset] = from[0];
        bonePositions[offset + 1] = from[1];
        bonePositions[offset + 2] = from[2];
        bonePositions[offset + 3] = to[0];
        bonePositions[offset + 4] = to[1];
        bonePositions[offset + 5] = to[2];
      }

      // A bone is only as trustworthy as its worse end, so it takes the
      // colour of whichever joint required more reconstruction.
      const colour = colourByProvenance
        ? PROVENANCE_COLOURS[worseSource(fromSource, toSource)]
        : PALETTE.bone;
      this.scratchColour.setHex(colour);
      for (const vertex of [0, 3]) {
        boneColours[offset + vertex] = this.scratchColour.r;
        boneColours[offset + vertex + 1] = this.scratchColour.g;
        boneColours[offset + vertex + 2] = this.scratchColour.b;
      }
    });
    this.bonePositions.needsUpdate = true;
    this.boneColours.needsUpdate = true;

    /* ---- joint markers ---- */

    CLARITY_JOINTS.forEach((joint, index) => {
      const provenance = frame.provenance.joints[joint];
      toVector(frame.body.joints[joint], this.scratchVector);

      // A missing joint shrinks rather than vanishing. An absent marker reads
      // as a rendering bug; a small dark one reads as "nothing was seen here",
      // which is what actually happened.
      const scale = provenance.source === "missing" ? 0.45 : 1;
      this.scratchMatrix.makeScale(scale, scale, scale);
      this.scratchMatrix.setPosition(this.scratchVector);
      this.jointMarkers.setMatrixAt(index, this.scratchMatrix);

      this.scratchColour.setHex(
        colourByProvenance ? PROVENANCE_COLOURS[provenance.source] : PALETTE.bone
      );
      this.jointMarkers.setColorAt(index, this.scratchColour);
    });
    this.jointMarkers.instanceMatrix.needsUpdate = true;
    if (this.jointMarkers.instanceColor) this.jointMarkers.instanceColor.needsUpdate = true;

    /* ---- persistent structures ---- */

    applyRigid(this.thoraxBox, frame.body.thorax, this.scratchVector, this.scratchQuat);
    applyRigid(this.pelvisBox, frame.body.pelvis, this.scratchVector, this.scratchQuat);

    /* ---- club ---- */

    if (frame.club) {
      const club = frame.club;
      const clubPositions = this.clubPositions.array as Float32Array;
      clubPositions[0] = club.grip[0];
      clubPositions[1] = club.grip[1];
      clubPositions[2] = club.grip[2];
      clubPositions[3] = club.head[0];
      clubPositions[4] = club.head[1];
      clubPositions[5] = club.head[2];
      this.clubPositions.needsUpdate = true;

      toVector(club.head, this.clubHeadMarker.position);
      toVector(club.cbp, this.cbpMarker.position);

      // Club opacity tracks its own confidence, so a CBP resting on stale
      // evidence visibly fades instead of looking as solid as a tracked one.
      const material = this.cbpMarker.material as MeshBasicMaterial;
      material.transparent = true;
      material.opacity = 0.25 + 0.75 * club.confidence;
      this.clubHeadMarker.visible = (this.layers?.club ?? true) && club.evidence.headObserved;
    } else {
      this.clubLine.visible = false;
      this.clubHeadMarker.visible = false;
      this.cbpMarker.visible = false;
    }

    if (this.trailPast) {
      this.trailPast.geometry.setDrawRange(0, Math.max(2, frame.index + 1));
    }

    /* ---- mass and support ---- */

    if (frame.mass) {
      const mass = frame.mass;

      toVector(mass.upperMassCentre, this.upperMassMarker.position);
      toVector(mass.upperMassGround, this.upperMassGroundRing.position);
      this.upperMassGroundRing.position.y = 0.004;
      toVector(mass.supportCentre, this.supportRing.position);
      this.supportRing.position.y = 0.006;

      const drop = this.upperMassDropPositions.array as Float32Array;
      drop[0] = mass.upperMassCentre[0];
      drop[1] = mass.upperMassCentre[1];
      drop[2] = mass.upperMassCentre[2];
      drop[3] = mass.upperMassGround[0];
      drop[4] = 0.004;
      drop[5] = mass.upperMassGround[2];
      this.upperMassDropPositions.needsUpdate = true;

      this.updateSupportPolygon(mass.supportPolygon);
      this.updateMassCloud(frame);
    }
  }

  private updateSupportPolygon(polygon: readonly Vec3[]) {
    const count = Math.min(polygon.length, MAX_SUPPORT_POINTS - 1);
    if (count < 2) {
      this.supportPolygonLine.geometry.setDrawRange(0, 0);
      return;
    }
    const positions = this.supportPolygonPositions.array as Float32Array;
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = polygon[i][0];
      positions[i * 3 + 1] = 0.003;
      positions[i * 3 + 2] = polygon[i][2];
    }
    // Close the loop by repeating the first point. A LineLoop would do this
    // for free but cannot also draw a two-point segment, which is exactly what
    // a stance up on its toes produces.
    positions[count * 3] = polygon[0][0];
    positions[count * 3 + 1] = 0.003;
    positions[count * 3 + 2] = polygon[0][2];

    this.supportPolygonPositions.needsUpdate = true;
    this.supportPolygonLine.geometry.setDrawRange(0, count + 1);
  }

  private updateMassCloud(frame: ClarityFrame) {
    const cloud = frame.mass?.cloud ?? [];
    const count = Math.min(cloud.length, this.massCloud.count);

    for (let i = 0; i < count; i += 1) {
      const parcel = cloud[i];
      // Radius by cube root of mass: a parcel carrying eight times the units
      // should read as twice as wide, not eight times.
      const radius = 0.018 + 0.052 * Math.cbrt(parcel.units / 25);
      this.scratchMatrix.makeScale(radius, radius, radius);
      this.scratchMatrix.setPosition(
        toVector(parcel.position, this.scratchVectorB)
      );
      this.massCloud.setMatrixAt(i, this.scratchMatrix);
      this.scratchColour.setHex(
        parcel.upper ? PALETTE.massCloudUpper : PALETTE.massCloudLower
      );
      this.massCloud.setColorAt(i, this.scratchColour);
    }
    // Instances beyond the cloud are collapsed rather than left at a stale
    // position, which would leave ghost parcels from a previous subject.
    for (let i = count; i < this.massCloud.count; i += 1) {
      this.scratchMatrix.makeScale(0, 0, 0);
      this.massCloud.setMatrixAt(i, this.scratchMatrix);
    }

    this.massCloud.instanceMatrix.needsUpdate = true;
    if (this.massCloud.instanceColor) this.massCloud.instanceColor.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ */

  /**
   * What sits under a point of the canvas, in normalised device coordinates
   * (-1..1, y up). Nearest hit wins; nothing hidden by a layer toggle counts.
   */
  pick(ndcX: number, ndcY: number): ScenePick | null {
    this.pointerNdc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.pointerNdc, this.rig.camera);

    const targets: { object: Mesh | InstancedMesh; pick: (instance?: number) => ScenePick }[] = [
      {
        object: this.jointMarkers,
        pick: (instance) => ({ kind: "joint", joint: CLARITY_JOINTS[instance ?? 0] }),
      },
      { object: this.clubHeadMarker, pick: () => ({ kind: "clubHead" }) },
      { object: this.cbpMarker, pick: () => ({ kind: "cbp" }) },
      { object: this.upperMassMarker, pick: () => ({ kind: "upperMass" }) },
      { object: this.upperMassGroundRing, pick: () => ({ kind: "upperMassGround" }) },
      { object: this.supportRing, pick: () => ({ kind: "support" }) },
    ];
    if (this.ballMarker) targets.push({ object: this.ballMarker, pick: () => ({ kind: "ball" }) });

    let best: { distance: number; pick: ScenePick } | null = null;
    for (const target of targets) {
      if (!target.object.visible) continue;
      // Picking is generous: a marker a couple of centimetres across is a
      // small target from across the room.
      const hits = this.raycaster.intersectObject(target.object, false);
      for (const hit of hits) {
        if (!best || hit.distance < best.distance) {
          best = { distance: hit.distance, pick: target.pick(hit.instanceId) };
        }
      }
    }
    return best?.pick ?? null;
  }

  setCameraPreset(preset: CameraPreset, immediate = false) {
    this.rig.applyPreset(preset, immediate);
  }

  resize(width: number, height: number, pixelRatio: number) {
    this.renderer.setPixelRatio(Math.min(pixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.rig.setAspect(height === 0 ? 1 : width / height);
  }

  render(deltaSeconds: number) {
    this.rig.update(deltaSeconds);
    this.renderer.render(this.scene, this.rig.camera);
  }

  dispose() {
    this.disposeTrail();
    this.scene.traverse((object) => {
      const mesh = object as Partial<Mesh>;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material?.dispose();
    });
    this.renderer.dispose();
  }
}

/* ---------------------------- helpers ------------------------------ */

const SOURCE_SEVERITY = {
  observed: 0,
  anchored: 0,
  constrained: 1,
  derived: 1,
  reconstructed: 2,
  extrapolated: 3,
  missing: 4,
} as const;

type Source = keyof typeof SOURCE_SEVERITY;

const worseSource = (a: Source, b: Source): Source =>
  SOURCE_SEVERITY[a] >= SOURCE_SEVERITY[b] ? a : b;

/**
 * A unit box drawn as translucent faces.
 *
 * The thorax and pelvis are shown as boxes because their ORIENTATION is the
 * point -- a cloud of joint markers cannot show that the pelvis has turned
 * forty degrees while the thorax has turned ninety, and that separation is
 * one of the things the persistent body model exists to make visible.
 */
const makeWireBox = (colour: number, opacity: number): Mesh => {
  const mesh = new Mesh(
    new BoxLikeGeometry(),
    new MeshBasicMaterial({
      color: colour,
      transparent: true,
      opacity,
      side: DoubleSide,
      depthWrite: false,
    })
  );
  mesh.frustumCulled = false;
  return mesh;
};

/** A 1x1x1 box centred on the origin, scaled per frame to the structure's extents. */
class BoxLikeGeometry extends BufferGeometry {
  constructor() {
    super();
    const h = 0.5;
    const corners: [number, number, number][] = [
      [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
      [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h],
    ];
    const faces = [
      [0, 1, 2, 0, 2, 3], [5, 4, 7, 5, 7, 6], [4, 0, 3, 4, 3, 7],
      [1, 5, 6, 1, 6, 2], [3, 2, 6, 3, 6, 7], [4, 5, 1, 4, 1, 0],
    ].flat();
    const positions = new Float32Array(faces.length * 3);
    faces.forEach((cornerIndex, i) => {
      const corner = corners[cornerIndex];
      positions[i * 3] = corner[0];
      positions[i * 3 + 1] = corner[1];
      positions[i * 3 + 2] = corner[2];
    });
    this.setAttribute("position", new BufferAttribute(positions, 3));
  }
}

const makeGroundRing = (colour: number, inner: number, outer: number): Mesh => {
  const mesh = new Mesh(
    new RingGeometry(inner, outer, 28),
    new MeshBasicMaterial({ color: colour, side: DoubleSide, transparent: true, opacity: 0.9 })
  );
  // RingGeometry is built in the XY plane; lay it flat on the ground.
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
};

const applyRigid = (
  mesh: Mesh,
  structure: { centre: Vec3; orientation: readonly [number, number, number, number]; halfExtents: Vec3; support: number },
  scratch: Vector3,
  scratchQuat: Quaternion
) => {
  toVector(structure.centre, scratch);
  mesh.position.copy(scratch);
  scratchQuat.set(
    structure.orientation[0],
    structure.orientation[1],
    structure.orientation[2],
    structure.orientation[3]
  );
  mesh.quaternion.copy(scratchQuat);
  mesh.scale.set(
    structure.halfExtents[0] * 2,
    structure.halfExtents[1] * 2,
    structure.halfExtents[2] * 2
  );

  // How much of the pose came from observation this frame, shown as opacity.
  // A structure coasting on its persistent model fades rather than looking as
  // solid as one being confirmed by fresh detections.
  const material = mesh.material as MeshBasicMaterial;
  material.opacity = 0.08 + 0.22 * structure.support;
};
