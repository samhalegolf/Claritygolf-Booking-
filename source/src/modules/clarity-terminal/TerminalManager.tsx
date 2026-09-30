import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { t } from "../../lib/i18n";
import { createTerminal, deleteTerminal, listTerminals, terminalLink, type CoachTerminal } from "./terminalApi";
import "./clarityTerminal.css";

// Setting terminals up: add one, copy its link to the camera computer, take one
// away. The one copy of it, shown both in Settings and inside the video
// workspace's Clarity Terminal panel.

/** Fast enough to see a terminal come online while setting it up. */
const STATUS_POLL_MS = 4000;

type TerminalManagerProps = {
  /** Told the list whenever it changes, so a caller can keep its own picker in step. */
  onTerminalsChange?: (terminals: CoachTerminal[]) => void;
  /** Told the new terminal's id when one is added here. */
  onAdded?: (terminal: CoachTerminal) => void;
};

const statusText = (terminal: CoachTerminal) => {
  if (!terminal.online) return t("Offline");
  if (!terminal.cameras.length) return t("No camera switched on");
  return terminal.cameras.map((camera) => camera.label).join(" · ");
};

export function TerminalManager({ onTerminalsChange, onAdded }: TerminalManagerProps) {
  const [terminals, setTerminals] = useState<CoachTerminal[] | null>(null);
  const [newName, setNewName] = useState("");
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");
  const onChangeRef = useRef(onTerminalsChange);
  onChangeRef.current = onTerminalsChange;

  const apply = useCallback((list: CoachTerminal[]) => {
    setTerminals(list);
    onChangeRef.current?.(list);
  }, []);

  // Re-read while on screen, so "Offline" turns into the terminal's cameras
  // the moment its link is opened on the camera computer.
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const list = await listTerminals();
        if (stopped) return;
        apply(list);
        setError("");
      } catch (reason) {
        if (!stopped) setError(reason instanceof Error ? reason.message : t("Clarity Terminal could not be reached."));
      }
      if (!stopped) timer = window.setTimeout(load, STATUS_POLL_MS);
    };
    void load();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [apply]);

  const addTerminal = async (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      const created = await createTerminal(name);
      setNewName("");
      apply([...(terminals || []), created]);
      onAdded?.(created);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("Clarity Terminal could not be reached."));
    }
  };

  const removeTerminal = async (entry: CoachTerminal) => {
    if (!window.confirm(t("Remove {name}? Its link will stop working.", { name: entry.name }))) return;
    try {
      await deleteTerminal(entry.id);
      apply((terminals || []).filter((terminal) => terminal.id !== entry.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("Clarity Terminal could not be reached."));
    }
  };

  const copyLink = async (entry: CoachTerminal) => {
    try {
      await navigator.clipboard.writeText(terminalLink(entry.code));
      setCopied(entry.id);
      window.setTimeout(() => setCopied(""), 2000);
    } catch {
      // The link is on screen to copy by hand.
    }
  };

  return (
    <div className="remote-camera-setup">
      <p className="terminal-hint">
        {t("Open a terminal's link on the computer the cameras are plugged into, and leave it running.")}
      </p>
      {terminals?.length ? (
        <ul className="remote-camera-links">
          {terminals.map((entry) => (
            <li key={entry.id}>
              <strong>{entry.name}</strong>
              <span className={`terminal-online${entry.online ? " is-online" : ""}`}>{statusText(entry)}</span>
              <code>{terminalLink(entry.code)}</code>
              <button type="button" className="terminal-button" onClick={() => void copyLink(entry)}>
                {copied === entry.id ? t("Copied") : t("Copy link")}
              </button>
              <button type="button" className="terminal-button" onClick={() => void removeTerminal(entry)}>
                {t("Remove")}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form onSubmit={(event) => void addTerminal(event)}>
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder={t("Bay 1")}
          aria-label={t("Terminal name")}
          maxLength={60}
        />
        <button type="submit" className="terminal-button is-primary" disabled={!newName.trim()}>
          {t("Add terminal")}
        </button>
      </form>
      {error ? <p className="terminal-error" role="alert">{error}</p> : null}
    </div>
  );
}

/** Settings › Integrations › Clarity Terminal. Lazy-loaded by the settings screen. */
export default function TerminalSettingsPanel() {
  return <TerminalManager />;
}
