import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Plus, Sparkles, X } from "lucide-react";

import "./bag.css";
import { apiFetch } from "../auth/apiFetch";
import { Loading } from "../shared/Loading";
import { t, tn } from "../../lib/i18n";
import {
  BAG_MAX_CLUBS,
  DEFAULT_SEVEN_IRON,
  addClub,
  clubKey,
  generateBag,
  generateRest,
  removeClub,
  updateClub,
  type BagClub,
  type BagCaddyState,
  type BagEditError,
  type PlayerBagView,
} from "../../../netlify/functions/_shared/bag-model.mts";

/* A player's bag: the clubs they carry and how far each one carries.
 *
 * One editor for both doors -- the coach on the player profile and the player
 * in the portal -- because it is one bag. It owns its own loading and saving;
 * the host only says where the bag lives and how to look.
 *
 * Clubs are laid out the way Clarity Caddy lays them out, so a player moving
 * between the two sees the same bag: two columns, longest club top-left, the
 * left column filled top to bottom before the right one starts.
 *
 * Every edit saves straight away. There is no Save button for the bag as a
 * whole -- an edit that is on screen but not stored is how a bag ends up
 * different in Booking and in Caddy.
 */

export type BagEditorProps = {
  /** GET returns { bag }, PUT takes { clubs, ...savePayload } and returns { bag }. */
  url: string;
  /** Extra fields the PUT needs, e.g. the coach's personId. */
  savePayload?: Record<string, string>;
  /** Who is looking: the words about syncing differ. */
  audience: "coach" | "player";
  /** "console" for the coach app's buttons, "portal" for the portal's. */
  variant: "console" | "portal";
  /** Whether to say anything about Clarity Caddy at all. */
  showCaddy: boolean;
  onUnauthorized?: () => void;
};

type Panel = "none" | "add" | "generate";

const ERROR_TEXT: Record<BagEditError, (club: string) => string> = {
  needsName: () => t("Give the club a name first."),
  needsCarry: () => t("Give the club a carry distance."),
  duplicate: (club) => t("{club} is already in the bag.", { club }),
  full: () => t("A bag holds up to {max} clubs.", { max: BAG_MAX_CLUBS }),
  sevenIronFirst: () => t("Enter a 7-iron carry first."),
};

function caddyLine(state: BagCaddyState, audience: BagEditorProps["audience"]): string {
  switch (state) {
    case "synced":
      return t("Synced with Clarity Caddy");
    case "waiting_for_phone":
      return t("Sent to Clarity Caddy. It updates on the phone next time Caddy opens.");
    case "unreachable":
      return t("Clarity Caddy could not be reached. The bag is saved here.");
    case "no_account":
      return t("No Clarity Caddy account to sync with yet.");
    case "not_linked":
      return audience === "coach" ? t("Give portal access to sync this bag with Clarity Caddy.") : "";
    default:
      return "";
  }
}

/** Sorted rows -> the DOM order a two-column, row-major grid needs to paint
 *  them as two top-to-bottom columns. Odd bags put the extra club on the left. */
function columnOrder(rows: BagClub[]): BagClub[] {
  const lines = Math.ceil(rows.length / 2);
  const out: BagClub[] = [];
  for (let line = 0; line < lines; line++) {
    for (let col = 0; col < 2; col++) {
      const row = rows[col * lines + line];
      if (row) out.push(row);
    }
  }
  return out;
}

export function BagEditor({ url, savePayload, audience, variant, showCaddy, onUnauthorized }: BagEditorProps) {
  /* The host re-renders on its own timers and hands fresh prop identities each
   * time. None of that is a change of bag, so nothing below keys on them. */
  const latest = useRef({ savePayload, onUnauthorized });
  useEffect(() => {
    latest.current = { savePayload, onUnauthorized };
  });

  const [view, setView] = useState<PlayerBagView | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<Panel>("none");
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editCarry, setEditCarry] = useState("");
  const [addName, setAddName] = useState("");
  const [addCarry, setAddCarry] = useState("");
  const [sevenIron, setSevenIron] = useState("");
  /* Saves that overtake each other: only the newest answer is drawn. */
  const saveSeq = useRef(0);

  const request = useCallback(async (init?: RequestInit) => {
    const response = await apiFetch(url, init);
    if (response.status === 401) {
      latest.current.onUnauthorized?.();
      throw new Error("unauthorized");
    }
    const data = (await response.json().catch(() => ({}))) as { bag?: PlayerBagView };
    if (!response.ok || !data.bag) throw new Error("failed");
    return data.bag;
  }, [url]);

  useEffect(() => {
    let live = true;
    setLoadState("loading");
    request()
      .then((bag) => {
        if (!live) return;
        setView(bag);
        setLoadState("loaded");
      })
      .catch(() => {
        if (live) setLoadState("error");
      });
    return () => {
      live = false;
    };
  }, [request]);

  const clubs = view?.clubs ?? [];

  const save = useCallback(
    async (next: BagClub[]) => {
      const before = view;
      const seq = ++saveSeq.current;
      setView((current) => (current ? { ...current, clubs: next } : current));
      setSaving(true);
      setError("");
      try {
        const bag = await request({
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...(latest.current.savePayload || {}), clubs: next }),
        });
        if (seq === saveSeq.current) setView(bag);
      } catch {
        if (seq === saveSeq.current) {
          setView(before);
          setError(t("Could not save the bag. Try again."));
        }
      } finally {
        if (seq === saveSeq.current) setSaving(false);
      }
    },
    [request, view],
  );

  function refuse(code: BagEditError | undefined, club = "") {
    if (!code) return false;
    setError(ERROR_TEXT[code](club));
    return true;
  }

  function openPanel(next: Panel) {
    setEditing(null);
    setError("");
    setPanel((current) => (current === next ? "none" : next));
    if (next === "generate" && !sevenIron) {
      const seven = clubs.find((row) => clubKey(row.club) === "7i");
      setSevenIron(String(seven?.baseCarry ?? ""));
    }
  }

  function submitAdd(event: FormEvent) {
    event.preventDefault();
    const result = addClub(clubs, addName, addCarry);
    if (refuse(result.error, addName.trim())) return;
    setAddName("");
    setAddCarry("");
    setPanel("none");
    void save(result.clubs);
  }

  function submitGenerate(event: FormEvent) {
    event.preventDefault();
    if (!(Number(sevenIron) > 0)) {
      refuse("sevenIronFirst");
      return;
    }
    /* With clubs already in the bag this only fills the gaps: the clubs the
       player set keep their own numbers. A full bag is only generated into an
       empty one, so nothing is ever replaced by a guess. */
    const next = clubs.length ? generateRest(clubs, sevenIron) : { clubs: generateBag(sevenIron) };
    if (refuse("error" in next ? next.error : undefined)) return;
    setPanel("none");
    void save(next.clubs);
  }

  function startEdit(row: BagClub) {
    setPanel("none");
    setError("");
    setEditing(row.club);
    setEditName(row.club);
    setEditCarry(String(row.baseCarry));
  }

  function submitEdit(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const result = updateClub(clubs, editing, { club: editName, carry: editCarry });
    if (refuse(result.error, editName.trim())) return;
    setEditing(null);
    void save(result.clubs);
  }

  function remove(club: string) {
    setEditing(null);
    void save(removeClub(clubs, club));
  }

  const primary = variant === "portal" ? "player-portal-primary" : "primary-button";
  const secondary = variant === "portal" ? "player-portal-ghost" : "outline-button";

  if (loadState === "loading") return <Loading what={t("bag")} className="bag-editor-empty" />;
  if (loadState === "error") return <p className="bag-editor-empty">{t("Could not load the bag.")}</p>;

  const sync = showCaddy && view ? caddyLine(view.caddy.state, audience) : "";

  return (
    <section className={`bag-editor is-${variant}`} aria-busy={saving}>
      <header className="bag-editor-head">
        <div>
          <strong>{t("Bag")}</strong>
          <span>
            {clubs.length ? tn(clubs.length, "{count} club", "{count} clubs") : t("No bag yet.")}
            {sync ? ` · ${sync}` : ""}
          </span>
        </div>
        <div className="bag-editor-actions">
          <button type="button" className={secondary} aria-expanded={panel === "add"} onClick={() => openPanel("add")}>
            <Plus size={15} />
            {t("Add a club")}
          </button>
          <button type="button" className={secondary} aria-expanded={panel === "generate"} onClick={() => openPanel("generate")}>
            <Sparkles size={15} />
            {clubs.length ? t("Fill the gaps") : t("Generate bag")}
          </button>
        </div>
      </header>

      {panel === "add" ? (
        <form className="bag-editor-form" onSubmit={submitAdd}>
          <label>
            <span>{t("Club")}</span>
            <input autoFocus maxLength={24} value={addName} onChange={(event) => setAddName(event.target.value)} placeholder="7i" />
          </label>
          <label>
            <span>{t("Carry (m)")}</span>
            <input inputMode="numeric" value={addCarry} onChange={(event) => setAddCarry(event.target.value.replace(/[^\d]/g, ""))} />
          </label>
          <button type="submit" className={primary}>{t("Add")}</button>
          <button type="button" className={secondary} onClick={() => setPanel("none")}>{t("Cancel")}</button>
        </form>
      ) : null}

      {panel === "generate" ? (
        <form className="bag-editor-form" onSubmit={submitGenerate}>
          <label>
            <span>{t("7-iron carry (m)")}</span>
            <input
              autoFocus
              inputMode="numeric"
              value={sevenIron}
              placeholder={String(DEFAULT_SEVEN_IRON)}
              onChange={(event) => setSevenIron(event.target.value.replace(/[^\d]/g, ""))}
            />
          </label>
          <button type="submit" className={primary}>{clubs.length ? t("Fill the gaps") : t("Generate bag")}</button>
          <button type="button" className={secondary} onClick={() => setPanel("none")}>{t("Cancel")}</button>
          <p className="bag-editor-hint">
            {clubs.length
              ? t("Adds the clubs that are missing. Clubs already in the bag keep their distances.")
              : t("A full set of clubs worked out from one 7-iron carry. Edit any club afterwards.")}
          </p>
        </form>
      ) : null}

      {error ? <p className="bag-editor-error" role="alert">{error}</p> : null}

      {clubs.length ? (
        <ol className="bag-grid">
          {columnOrder(clubs).map((row) =>
            editing === row.club ? (
              <li key={row.club} className="bag-club is-editing">
                <form onSubmit={submitEdit}>
                  <input aria-label={t("Club")} autoFocus maxLength={24} value={editName} onChange={(event) => setEditName(event.target.value)} />
                  <input
                    aria-label={t("Carry (m)")}
                    inputMode="numeric"
                    value={editCarry}
                    onChange={(event) => setEditCarry(event.target.value.replace(/[^\d]/g, ""))}
                  />
                  <div className="bag-club-edit-actions">
                    <button type="submit" className={primary}>{t("Save")}</button>
                    <button type="button" className={secondary} onClick={() => remove(row.club)}>{t("Remove")}</button>
                    <button type="button" className="bag-club-close" aria-label={t("Cancel")} onClick={() => setEditing(null)}>
                      <X size={15} />
                    </button>
                  </div>
                </form>
              </li>
            ) : (
              <li key={row.club} className="bag-club">
                <button type="button" onClick={() => startEdit(row)}>
                  <strong>{row.club}</strong>
                  <span className="bag-club-carry">{t("{carry} m", { carry: row.baseCarry })}</span>
                  <span className="bag-club-total">{t("Total {total} m", { total: row.totalM })}</span>
                </button>
              </li>
            ),
          )}
        </ol>
      ) : (
        <p className="bag-editor-empty">
          {t("Add clubs one at a time, or generate a full bag from a 7-iron carry.")}
        </p>
      )}
    </section>
  );
}
