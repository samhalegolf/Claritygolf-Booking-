// The Putting Lab engine, off the main thread. The page sends one frame at a
// time (RGBA, transferred, not copied) and gets a snapshot back; it does not
// send the next frame until the snapshot arrives, so a slow frame means a
// dropped frame, never a growing delay.

import { PuttingLabEngine, type PuttingLabConfiguration } from "./engine/engine";
import { lumaFromRGBA } from "./engine/luma";
import type { DeviceAttitude } from "./engine/motion";
import type { PracticeTarget } from "./engine/coordinates";
import type { ValidationRun } from "./engine/stroke";

export type WorkerRequest =
  | { kind: "configure"; configuration: PuttingLabConfiguration }
  | { kind: "frame"; rgba: ArrayBuffer; width: number; height: number; timestamp: number; attitude: DeviceAttitude | null }
  | { kind: "setTarget"; target: PracticeTarget }
  | { kind: "recalibrate" }
  | { kind: "startLive" }
  | { kind: "beginValidation"; validation: ValidationRun["kind"]; known: number }
  | { kind: "endValidation" };

export type WorkerResponse =
  | { kind: "snapshot"; snapshot: PuttingLabEngine["snapshot"] }
  | { kind: "stroke"; stroke: PuttingLabEngine["strokes"][number] }
  | { kind: "validation"; run: ValidationRun | null };

type WorkerScope = {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

const scope = self as unknown as WorkerScope;
let engine = new PuttingLabEngine();
let luma: Uint8Array = new Uint8Array(0);

function attach(e: PuttingLabEngine) {
  e.onStroke = (stroke) => scope.postMessage({ kind: "stroke", stroke });
}
attach(engine);

scope.onmessage = ({ data }) => {
  switch (data.kind) {
    case "configure":
      engine = new PuttingLabEngine(data.configuration);
      attach(engine);
      break;
    case "frame": {
      const plane = lumaFromRGBA(new Uint8ClampedArray(data.rgba), data.width, data.height, luma);
      luma = plane.data;
      scope.postMessage({ kind: "snapshot", snapshot: engine.process(plane, data.timestamp, data.attitude) });
      break;
    }
    case "setTarget":
      engine.setTarget(data.target);
      break;
    case "recalibrate":
      engine.recalibrate();
      break;
    case "startLive":
      engine.startLive();
      break;
    case "beginValidation":
      engine.beginValidation(data.validation, data.known);
      break;
    case "endValidation":
      scope.postMessage({ kind: "validation", run: engine.endValidation() });
      break;
  }
};
