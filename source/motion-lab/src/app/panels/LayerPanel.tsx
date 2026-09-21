/**
 * Layer toggles and the provenance key.
 *
 * Deliberately exposes more than a finished product would. This build is
 * partly an instrumentation environment: the goal is to find out which
 * signals are actually useful before deciding what a coach should see.
 */

import { CAMERA_PRESETS, type CameraPreset } from "../../space3d/cameraRig";
import { LAYER_DESCRIPTORS, type SceneLayers } from "../../space3d/layers";
import { PROVENANCE_COLOURS, PROVENANCE_LABELS } from "../../space3d/palette";

const GROUPS = ["Body", "Club", "Mass", "Scene"] as const;

const hexToCss = (hex: number) => `#${hex.toString(16).padStart(6, "0")}`;

export function LayerPanel({
  layers,
  onToggle,
  cameraPreset,
  onCameraPreset,
}: {
  layers: SceneLayers;
  onToggle: (key: keyof SceneLayers, value: boolean) => void;
  cameraPreset: CameraPreset;
  onCameraPreset: (preset: CameraPreset) => void;
}) {
  return (
    <div className="panel">
      <h2 className="panel-title">View</h2>

      <div className="camera-buttons">
        {CAMERA_PRESETS.map((preset) => (
          <button
            key={preset.key}
            type="button"
            title={preset.hint}
            className={preset.key === cameraPreset ? "chip chip-active" : "chip"}
            onClick={() => onCameraPreset(preset.key)}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <p className="panel-note">
        Presets are defined against the measured stance line, not an assumed target
        direction — the video never says where the target is. Drag to orbit,
        shift-drag or right-drag to pan, scroll to zoom.
      </p>

      {GROUPS.map((group) => (
        <section key={group}>
          <h3 className="panel-subtitle">{group}</h3>
          {LAYER_DESCRIPTORS.filter((descriptor) => descriptor.group === group).map(
            (descriptor) => (
              <label className="toggle" key={descriptor.key} title={descriptor.hint}>
                <input
                  type="checkbox"
                  checked={layers[descriptor.key]}
                  onChange={(event) => onToggle(descriptor.key, event.target.checked)}
                />
                <span>{descriptor.label}</span>
              </label>
            )
          )}
        </section>
      ))}

      <h3 className="panel-subtitle">Provenance key</h3>
      <ul className="legend">
        {(Object.keys(PROVENANCE_COLOURS) as (keyof typeof PROVENANCE_COLOURS)[]).map(
          (source) => (
            <li key={source}>
              <span
                className="legend-swatch"
                style={{ background: hexToCss(PROVENANCE_COLOURS[source]) }}
              />
              {PROVENANCE_LABELS[source]}
            </li>
          )
        )}
      </ul>
    </div>
  );
}
