import { useEffect, useState } from "react";

import { t } from "../../../lib/i18n";

/**
 * One of the player's saved videos, as a picker shows it. The same shape the
 * 3D view's second-angle picker takes, so one listing feeds both.
 */
export interface LibraryClip {
  readonly id: string;
  readonly title: string;
  /** When it was filmed, and where it is kept. */
  readonly detail: string;
  readonly thumbnail?: string;
  /** The library takes this for the same swing as the clip already open. */
  readonly sameSwing?: boolean;
}

type LibraryClipPanelProps = {
  /** The player's library, fetched when the panel opens. */
  list: () => Promise<readonly LibraryClip[]>;
  /** Load the chosen clip into this side. Rejects with a message to show. */
  onPick: (id: string) => Promise<void>;
  onClose: () => void;
};

/**
 * The player's library, inside an empty video panel: the way to put a video
 * already saved -- on this device or in Clarity Cloud -- on either side,
 * beside Record and Upload. A clip that is only in the cloud downloads when
 * it is picked.
 */
export function LibraryClipPanel({ list, onPick, onClose }: LibraryClipPanelProps) {
  const [clips, setClips] = useState<readonly LibraryClip[] | null>(null);
  const [error, setError] = useState("");
  const [loadingId, setLoadingId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    list()
      .then((result) => live && setClips(result))
      .catch((reason: unknown) => {
        if (!live) return;
        setClips([]);
        setError(reason instanceof Error ? reason.message : t("That video could not be loaded."));
      });
    return () => {
      live = false;
    };
  }, [list]);

  const pick = async (id: string) => {
    setLoadingId(id);
    setError("");
    try {
      await onPick(id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("That video could not be loaded."));
      setLoadingId(null);
    }
  };

  return (
    <section className="library-clip-panel" aria-label={t("From library")}>
      <div className="library-clip-head">
        <h2>{t("From library")}</h2>
        <button type="button" className="upload-button is-subtle" onClick={onClose}>
          {t("Close")}
        </button>
      </div>
      {error ? (
        <p className="video-upload-error" role="alert">
          {error}
        </p>
      ) : null}
      {clips === null ? (
        <p className="library-clip-note">{t("Loading the library…")}</p>
      ) : clips.length === 0 ? (
        <p className="library-clip-note">{t("No saved videos for this player yet.")}</p>
      ) : (
        <ul className="library-clip-list">
          {clips.map((clip) => (
            <li key={clip.id}>
              <button
                type="button"
                className="library-clip-item"
                disabled={loadingId !== null}
                onClick={() => void pick(clip.id)}
              >
                {clip.thumbnail ? (
                  <img className="library-clip-thumb" src={clip.thumbnail} alt="" />
                ) : (
                  <span className="library-clip-thumb" aria-hidden="true" />
                )}
                <span className="library-clip-text">
                  <strong>
                    {clip.title}
                    {clip.sameSwing ? <span className="library-clip-badge">{t("Same swing")}</span> : null}
                  </strong>
                  <span>{loadingId === clip.id ? t("Loading…") : clip.detail}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
