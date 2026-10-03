// Settings > Sandbox > Industry profile builder.
//
// The sandbox's version of "what kind of business is this?". It edits the
// sandbox account's real market config through the same /api/market-profile
// route a live account would use, so what it shows is what a business on that
// configuration would see -- not a preview.
//
// Odd combinations are the point. A preset only fills the controls below it;
// nothing stops a Hair & Beauty business switching Video Analysis on, and that
// is exactly how a module's hidden golf assumptions get found.
//
// The copy here is English only, deliberately: this is a developer harness
// inside the sandbox, not a screen a business's customers see.

import { useEffect, useMemo, useState } from "react";

import {
  TERMINOLOGY_KEYS,
  type BusinessTerminology,
} from "../../../netlify/functions/_shared/business-terminology.mts";
import {
  overridesFor,
  type AccountMarketConfig,
  type CapabilityKey,
  type MarketCapabilities,
} from "../../../netlify/functions/_shared/market-profile.mts";
import {
  deleteCustomMarketPreset,
  fetchMarketProfile,
  saveCustomMarketPreset,
  saveMarketProfile,
  type MarketProfileState,
} from "./sandboxApi";
import { LEAK_DETECTOR_EVENT, leakDetectorEnabled, setLeakDetectorEnabled } from "./leakDetectorSwitch";
import "./sandbox.css";

const TERM_LABELS: Record<keyof BusinessTerminology, string> = {
  staffSingular: "Staff",
  staffPlural: "Staff (plural)",
  customerSingular: "Customer",
  customerPlural: "Customer (plural)",
  serviceSingular: "Service",
  servicePlural: "Service (plural)",
  resourceSingular: "Resource",
  resourcePlural: "Resource (plural)",
  assignmentPlural: "Assignment module",
  assignmentSingular: "Assignment item",
};

export type MarketProfileBuilderProps = {
  /** Lets the workspace around the panel re-render in the new words at once. */
  onMarketChange?: (config: AccountMarketConfig, terminology: BusinessTerminology) => void;
};

export default function MarketProfileBuilder({ onMarketChange }: MarketProfileBuilderProps) {
  const [state, setState] = useState<MarketProfileState | null>(null);
  const [words, setWords] = useState<BusinessTerminology | null>(null);
  const [presetName, setPresetName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [detectorOn, setDetectorOn] = useState(leakDetectorEnabled);

  useEffect(() => {
    let cancelled = false;
    fetchMarketProfile()
      .then((next) => {
        if (cancelled) return;
        setState(next);
        setWords(next.market.terminology);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    const syncDetector = () => setDetectorOn(leakDetectorEnabled());
    window.addEventListener(LEAK_DETECTOR_EVENT, syncDetector);
    return () => {
      cancelled = true;
      window.removeEventListener(LEAK_DETECTOR_EVENT, syncDetector);
    };
  }, []);

  async function run(work: () => Promise<MarketProfileState>, done = "") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await work();
      setState(next);
      setWords(next.market.terminology);
      onMarketChange?.(next.config, next.market.terminology);
      if (done) setNotice(done);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  const wordsDirty = useMemo(
    () => Boolean(state && words && TERMINOLOGY_KEYS.some((key) => words[key] !== state.market.terminology[key])),
    [state, words],
  );

  if (error && !state) return <p className="sandbox-panel__error">{error}</p>;
  if (!state || !words) return <p className="sandbox-panel__lede">Loading the industry profile…</p>;

  const { config, market } = state;
  // Which saved preset, if any, the account is exactly on right now.
  const activePreset = state.customPresets.find(
    (preset) =>
      preset.baseProfileId === config.profileId &&
      JSON.stringify(overridesFor(preset.baseProfileId, preset.capabilities)) ===
        JSON.stringify(config.capabilityOverrides) &&
      TERMINOLOGY_KEYS.every((key) => preset.terminology[key] === market.terminology[key]),
  );
  const selectValue = activePreset ? `preset:${activePreset.id}` : `profile:${config.profileId}`;

  function choose(value: string) {
    if (value.startsWith("preset:")) {
      const id = value.slice("preset:".length);
      void run(() => saveMarketProfile({ applyPresetId: id }), "Preset applied.");
    } else {
      const id = value.slice("profile:".length) as AccountMarketConfig["profileId"];
      void run(() => saveMarketProfile({ applyProfileId: id }), "Profile applied.");
    }
  }

  function toggle(key: CapabilityKey, on: boolean) {
    const capabilities: MarketCapabilities = { ...market.capabilities, [key]: on };
    void run(() =>
      saveMarketProfile({
        config: { profileId: config.profileId, capabilityOverrides: overridesFor(config.profileId, capabilities) },
        terminology: market.terminology,
      }),
    );
  }

  return (
    <div className="market-builder">
      <p className="sandbox-panel__lede">
        One application, presented per industry. Pick a starting profile, then change any word or module — a
        preset only fills these controls, it never locks them. Strange combinations are welcome: they are how
        hidden golf assumptions get found.
      </p>

      <div className="market-builder__row">
        <label className="settings-field">
          <span>Industry preset</span>
          <select value={selectValue} disabled={busy} onChange={(event) => choose(event.target.value)}>
            <optgroup label="Built in">
              {state.profiles.map((profile) => (
                <option key={profile.id} value={`profile:${profile.id}`}>
                  {profile.label}
                </option>
              ))}
            </optgroup>
            {state.customPresets.length ? (
              <optgroup label="Saved presets">
                {state.customPresets.map((preset) => (
                  <option key={preset.id} value={`preset:${preset.id}`}>
                    {preset.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>
        <p className="market-builder__product">
          Runs as <strong>{market.product.name}</strong>
          {config.capabilityOverrides && Object.keys(config.capabilityOverrides).length
            ? ` · ${Object.keys(config.capabilityOverrides).length} module change(s) from ${market.label}`
            : ` · ${market.label} defaults`}
        </p>
      </div>

      <h4 className="market-builder__heading">Vocabulary</h4>
      <div className="market-builder__words">
        {TERMINOLOGY_KEYS.map((key) => (
          <label className="settings-field" key={key}>
            <span>{TERM_LABELS[key]}</span>
            <input
              value={words[key]}
              maxLength={40}
              disabled={busy}
              onChange={(event) => setWords({ ...words, [key]: event.target.value })}
            />
          </label>
        ))}
      </div>
      <div className="market-builder__row">
        <button
          type="button"
          className="primary"
          disabled={busy || !wordsDirty}
          onClick={() => void run(() => saveMarketProfile({ config, terminology: words }), "Words saved.")}
        >
          Save words
        </button>
        {wordsDirty ? (
          <button type="button" className="outline-button" disabled={busy} onClick={() => setWords(market.terminology)}>
            Undo
          </button>
        ) : null}
      </div>

      <h4 className="market-builder__heading">Modules</h4>
      <ul className="market-builder__capabilities">
        {state.capabilities.map((definition) => {
          const changed = definition.key in config.capabilityOverrides;
          return (
            <li key={definition.key} className={changed ? "is-changed" : undefined}>
              <label>
                <input
                  type="checkbox"
                  checked={market.capabilities[definition.key]}
                  disabled={busy || definition.reserved}
                  onChange={(event) => toggle(definition.key, event.target.checked)}
                />
                <span className="market-builder__capability-name">
                  {definition.label}
                  {changed ? <em> changed from preset</em> : null}
                  {definition.reserved ? <em> reserved</em> : null}
                </span>
              </label>
              <small>{definition.gates}</small>
            </li>
          );
        })}
      </ul>

      <h4 className="market-builder__heading">Save this combination</h4>
      <div className="market-builder__row">
        <label className="settings-field">
          <span>Preset name</span>
          <input
            value={presetName}
            maxLength={60}
            placeholder="e.g. Hair Video Consultation"
            disabled={busy}
            onChange={(event) => setPresetName(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="primary"
          disabled={busy || !presetName.trim() || wordsDirty}
          title={wordsDirty ? "Save or undo the word changes first" : undefined}
          onClick={() =>
            void run(
              () =>
                saveCustomMarketPreset({
                  name: presetName.trim(),
                  baseProfileId: config.profileId,
                  terminology: market.terminology,
                  capabilities: market.capabilities,
                }),
              `Saved “${presetName.trim()}”.`,
            ).then(() => setPresetName(""))
          }
        >
          Save preset
        </button>
      </div>
      {state.customPresets.length ? (
        <ul className="market-builder__presets">
          {state.customPresets.map((preset) => (
            <li key={preset.id}>
              <strong>{preset.name}</strong>
              <span>
                {preset.terminology.staffSingular} · {preset.terminology.customerSingular} ·{" "}
                {preset.terminology.serviceSingular}
              </span>
              <button
                type="button"
                className="outline-button"
                disabled={busy}
                onClick={() => void run(() => deleteCustomMarketPreset(preset.id), "Preset removed.")}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="sandbox-panel__note">
        Saved presets are recipes, not new apps: they live on this sandbox and apply the same profile, words and
        modules to the same application.
      </p>

      <h4 className="market-builder__heading">Industry leak detection</h4>
      <label className="market-builder__detector">
        <input
          type="checkbox"
          checked={detectorOn}
          onChange={(event) => {
            setLeakDetectorEnabled(event.target.checked);
            setDetectorOn(event.target.checked);
          }}
        />
        <span>
          Highlight words that do not belong to this industry, and modules that are on screen while switched off.
          Sandbox only, this browser only.
        </span>
      </label>

      {notice ? <p className="sandbox-panel__note">{notice}</p> : null}
      {error ? <p className="sandbox-panel__error">{error}</p> : null}
    </div>
  );
}
