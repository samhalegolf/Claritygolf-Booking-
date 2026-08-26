import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

import "./practice.css";
import "./practiceSettings.css";
import { apiFetch } from "../auth/apiFetch";
import {
  DEFAULT_PRACTICE_TYPES,
  PRACTICE_FIELDS,
  practiceTypeId,
  practiceTypeList,
  type PracticeFieldKey,
  type PracticePreset,
  type PracticeTypeMeta,
} from "./practiceModel";
import { invalidateAllPractice } from "./practiceStore";

/* Practice settings: the kinds of block a coach can assign, and the
 * favourites rail behind them.
 *
 * This is the Preferences end of Practice -- visited when something needs
 * renaming, not while coaching -- so it lives in Settings rather than in the
 * panel a coach works in. The two things it owns are the two things the
 * composer offers before anybody types: which tabs exist, and what is on the
 * Saved rail.
 *
 * Block types are edited as a list and saved as a list. Order is the tab
 * order, ids are what every assigned block points at, and neither is
 * something you can get right one row at a time -- so there is one Save for
 * the whole set rather than a write per keystroke.
 */

export type PracticeSettingsPanelProps = {
  onToast: (message: string) => void;
};

type Row = PracticeTypeMeta & { fresh?: boolean };

function toRows(types: PracticeTypeMeta[]): Row[] {
  return types.map((type) => ({ ...type, fields: { ...type.fields } }));
}

export function PracticeSettingsPanel({ onToast }: PracticeSettingsPanelProps) {
  const [rows, setRows] = useState<Row[]>(() => toRows(DEFAULT_PRACTICE_TYPES));
  const [saved, setSaved] = useState<Row[]>(() => toRows(DEFAULT_PRACTICE_TYPES));
  const [favourites, setFavourites] = useState<PracticePreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [typesResponse, favouritesResponse] = await Promise.all([
        apiFetch("/api/practice-block-types"),
        apiFetch("/api/practice-block-presets"),
      ]);
      const typesData = (await typesResponse.json().catch(() => ({}))) as {
        blockTypes?: PracticeTypeMeta[];
        message?: string;
      };
      if (!typesResponse.ok) throw new Error(typesData?.message || "Could not load block types.");
      // An empty list is a workspace that has never edited them, not a
      // workspace with none -- the defaults are what it is actually running.
      const next = toRows(practiceTypeList(typesData.blockTypes));
      setRows(next);
      setSaved(next);

      const favouritesData = (await favouritesResponse.json().catch(() => ({}))) as { presets?: PracticePreset[] };
      if (favouritesResponse.ok) setFavourites(Array.isArray(favouritesData.presets) ? favouritesData.presets : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load practice settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => JSON.stringify(rows) !== JSON.stringify(saved), [rows, saved]);

  const patch = useCallback((id: string, change: Partial<Row>) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...change } : row)));
  }, []);

  const move = useCallback((id: string, delta: number) => {
    setRows((current) => {
      const index = current.findIndex((row) => row.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = current.slice();
      next.splice(target, 0, next.splice(index, 1)[0]);
      return next;
    });
  }, []);

  const addType = useCallback(() => {
    setRows((current) => {
      const id = practiceTypeId("New type", current.map((row) => row.id));
      const row: Row = {
        id,
        label: "New type",
        hint: "",
        tone: "#3f6b52",
        titleHint: "",
        doseHint: "",
        fields: { steps: true, dose: true, expiry: true, video: true },
        archived: false,
        fresh: true,
      };
      setOpenId(id);
      // Second to last, so whichever type the coach has sitting in the escape
      // hatch position stays there.
      return current.length > 1
        ? [...current.slice(0, -1), row, current[current.length - 1]]
        : [...current, row];
    });
  }, []);

  const save = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await apiFetch("/api/practice-block-types", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // `fresh` is a flag about this editing session, not about the type.
        body: JSON.stringify({ blockTypes: rows.map(({ fresh: _fresh, ...type }) => type) }),
      });
      const data = (await response.json().catch(() => ({}))) as { blockTypes?: PracticeTypeMeta[]; message?: string };
      if (!response.ok) throw new Error(data?.message || "Could not save block types.");
      const next = toRows(practiceTypeList(data.blockTypes));
      setRows(next);
      setSaved(next);
      // Every player's practice is now painted with the wrong names or
      // colours until it is re-read.
      invalidateAllPractice();
      onToast("Block types saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save block types.");
    } finally {
      setBusy(false);
    }
  }, [busy, onToast, rows]);

  const removeFavourite = useCallback(
    async (preset: PracticePreset) => {
      if (busy) return;
      if (!window.confirm(`Remove "${preset.title}" from favourites? Blocks already assigned from it stay as they are.`)) {
        return;
      }
      setBusy(true);
      try {
        await apiFetch(`/api/practice-block-presets?id=${encodeURIComponent(preset.id)}`, { method: "DELETE" });
        setFavourites((current) => current.filter((item) => item.id !== preset.id));
        invalidateAllPractice();
      } catch {
        setError("Could not remove that favourite.");
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  if (loading) return <div className="module-loading">Loading practice settings…</div>;

  return (
    <div className="practice-settings">
      <section className="practice-settings-section">
        <div className="practice-settings-head">
          <div>
            <h4>Block types</h4>
            <p>
              The tabs across the top of the composer. A type is a name, a colour and which fields it asks
              for — it never changes what a block does, so renaming or recolouring one is safe at any time.
            </p>
          </div>
          <button type="button" className="outline-button" onClick={addType}>
            + Add type
          </button>
        </div>

        <ul className="practice-type-rows">
          {rows.map((row, index) => {
            const open = openId === row.id;
            return (
              <li className="practice-type-row" key={row.id} data-archived={row.archived ? "1" : undefined}>
                <div className="practice-type-row-head">
                  <span
                    className="practice-type-swatch"
                    style={{ "--practice-tone": row.tone } as CSSProperties}
                    aria-hidden="true"
                  />
                  <button
                    type="button"
                    className="practice-type-row-open"
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : row.id)}
                  >
                    <strong>{row.label || "Untitled"}</strong>
                    <span>
                      {row.archived
                        ? "Retired"
                        : PRACTICE_FIELDS.filter((field) => row.fields[field.key] !== false)
                            .map((field) => field.label.toLowerCase())
                            .join(" · ") || "title only"}
                    </span>
                  </button>
                  <div className="practice-type-row-tools">
                    <button
                      type="button"
                      title="Move up"
                      aria-label={`Move ${row.label} up`}
                      disabled={index === 0}
                      onClick={() => move(row.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      title="Move down"
                      aria-label={`Move ${row.label} down`}
                      disabled={index === rows.length - 1}
                      onClick={() => move(row.id, 1)}
                    >
                      ↓
                    </button>
                  </div>
                </div>

                {open && (
                  <div className="practice-type-editor">
                    <div className="practice-type-editor-grid">
                      <label className="settings-field">
                        <span>Name</span>
                        <input
                          value={row.label}
                          maxLength={60}
                          onChange={(event) => patch(row.id, { label: event.target.value })}
                        />
                      </label>
                      <label className="settings-field practice-type-colour">
                        <span>Colour</span>
                        <input
                          type="color"
                          value={row.tone}
                          aria-label={`Colour for ${row.label}`}
                          onChange={(event) => patch(row.id, { tone: event.target.value })}
                        />
                      </label>
                      <label className="settings-field">
                        <span>What it's for</span>
                        <input
                          value={row.hint}
                          maxLength={80}
                          placeholder="one thing, reps"
                          onChange={(event) => patch(row.id, { hint: event.target.value })}
                        />
                      </label>
                      <label className="settings-field">
                        <span>Example title</span>
                        <input
                          value={row.titleHint}
                          maxLength={80}
                          placeholder="Gate Drill"
                          onChange={(event) => patch(row.id, { titleHint: event.target.value })}
                        />
                      </label>
                      {row.fields.dose !== false && (
                        <label className="settings-field">
                          <span>Example dose</span>
                          <input
                            value={row.doseHint}
                            maxLength={40}
                            placeholder="20 balls"
                            onChange={(event) => patch(row.id, { doseHint: event.target.value })}
                          />
                        </label>
                      )}
                    </div>

                    <fieldset className="practice-type-fields">
                      <legend>Fields this type asks for</legend>
                      {PRACTICE_FIELDS.map((field) => (
                        <label key={field.key} title={field.hint}>
                          <input
                            type="checkbox"
                            checked={row.fields[field.key] !== false}
                            onChange={(event) =>
                              patch(row.id, {
                                fields: { ...row.fields, [field.key as PracticeFieldKey]: event.target.checked },
                              })
                            }
                          />
                          <span>
                            <strong>{field.label}</strong>
                            <em>{field.hint}</em>
                          </span>
                        </label>
                      ))}
                    </fieldset>

                    <div className="practice-type-editor-actions">
                      {/* Retire, never delete. Every block ever assigned points
                          at this id, and they keep this name and colour on the
                          wall long after the type stops being offered. */}
                      <label className="practice-type-retire">
                        <input
                          type="checkbox"
                          checked={row.archived}
                          onChange={(event) => patch(row.id, { archived: event.target.checked })}
                        />
                        Retire this type — blocks already assigned keep it
                      </label>
                      {row.fresh && (
                        <button
                          type="button"
                          className="practice-clear"
                          onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))}
                        >
                          Discard
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {error && (
          <p className="practice-error" role="alert">
            {error}
          </p>
        )}

        <div className="practice-settings-actions">
          <button type="button" className="primary-button" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save block types"}
          </button>
          <button type="button" className="outline-button" disabled={!dirty || busy} onClick={() => setRows(saved)}>
            Discard changes
          </button>
          <button
            type="button"
            className="practice-clear"
            disabled={busy}
            onClick={() => {
              if (!window.confirm("Put the five starting types back? Anything you have added stays.")) return;
              setRows((current) => {
                const byId = new Map(current.map((row) => [row.id, row]));
                const restored = toRows(DEFAULT_PRACTICE_TYPES);
                const extras = current.filter((row) => !restored.some((base) => base.id === row.id));
                return [...restored.map((base) => ({ ...base, archived: byId.get(base.id)?.archived ?? false })), ...extras];
              });
            }}
          >
            Reset to defaults
          </button>
        </div>
      </section>

      <section className="practice-settings-section">
        <div className="practice-settings-head">
          <div>
            <h4>Favourites</h4>
            <p>
              The Saved rail beside the composer. These are added with ★ while assigning, and reordered by
              dragging them there — this is where you clear out the ones you have stopped using.
            </p>
          </div>
        </div>

        {favourites.length ? (
          <ul className="practice-favourite-rows">
            {favourites.map((preset) => (
              <li key={preset.id}>
                <span
                  className="practice-type-swatch"
                  style={
                    { "--practice-tone": practiceTypeList(saved).find((t) => t.id === preset.blockType)?.tone } as CSSProperties
                  }
                  aria-hidden="true"
                />
                <div>
                  <strong>{preset.title}</strong>
                  <span>{preset.content.split("\n").filter(Boolean).length} steps{preset.dose ? ` · ${preset.dose}` : ""}</span>
                </div>
                <button type="button" className="outline-button" disabled={busy} onClick={() => void removeFavourite(preset)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="practice-settings-empty">
            Nothing saved yet. Press ★ beside Save while assigning a block to keep it here.
          </p>
        )}
      </section>
    </div>
  );
}

export default PracticeSettingsPanel;
