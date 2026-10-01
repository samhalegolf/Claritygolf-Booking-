import { useEffect, useMemo, useState } from "react";

import { t } from "../../../lib/i18n";

/**
 * One saved video, as a picker shows it. The same shape the 3D view's
 * second-angle picker takes, so one listing feeds both.
 */
export interface LibraryClip {
  readonly id: string;
  readonly title: string;
  /** When it was filmed, and where it is kept. */
  readonly detail: string;
  readonly thumbnail?: string;
  /** The library takes this for the same swing as the clip already open. */
  readonly sameSwing?: boolean;
  /** Worth showing first: the same swing, or a clip from this lesson. */
  readonly likely?: boolean;
}

/** A player the search can find, with every id their videos are filed under. */
export interface LibraryPlayer {
  readonly playerName: string;
  readonly playerIds: readonly string[];
}

type LibraryClipPanelProps = {
  /** Whose workspace this is. Unset when it was opened without a player. */
  playerName?: string;
  /** This player's clips, likely pairings first. */
  listThisPlayer: () => Promise<readonly LibraryClip[]>;
  /** Videos saved before the workspace asked whose they were. */
  listUnassigned: () => Promise<readonly LibraryClip[]>;
  /** Everyone with a saved video, for the search. */
  players: readonly LibraryPlayer[];
  listPlayer: (playerIds: readonly string[]) => Promise<readonly LibraryClip[]>;
  /** Load the chosen clip into this side. Rejects with a message to show. */
  onPick: (id: string) => Promise<void>;
  onClose: () => void;
};

type Folder = { kind: "home" } | { kind: "unassigned" } | { kind: "player"; player: LibraryPlayer };

const loadErrorMessage = (reason: unknown) =>
  reason instanceof Error ? reason.message : t("That video could not be loaded.");

/** Fetches a listing whenever the function changes; null while loading. */
function useClipListing(list: () => Promise<readonly LibraryClip[]>) {
  const [clips, setClips] = useState<readonly LibraryClip[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setClips(null);
    setError("");
    list()
      .then((result) => live && setClips(result))
      .catch((reason: unknown) => {
        if (!live) return;
        setClips([]);
        setError(loadErrorMessage(reason));
      });
    return () => {
      live = false;
    };
  }, [list]);
  return { clips, error };
}

/**
 * The library, inside a video panel: the way to put a video already saved --
 * on this device or in Clarity Cloud -- on either side. It opens on this
 * player's likely pairings, keeps unassigned videos in a folder of their own,
 * and searches by player for anything else. A clip that is only in the cloud
 * downloads when it is picked.
 */
export function LibraryClipPanel({
  playerName,
  listThisPlayer,
  listUnassigned,
  players,
  listPlayer,
  onPick,
  onClose,
}: LibraryClipPanelProps) {
  const [folder, setFolder] = useState<Folder>({ kind: "home" });
  const [query, setQuery] = useState("");
  const [pickError, setPickError] = useState("");
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const listFolder = useMemo(() => {
    if (folder.kind === "unassigned") return listUnassigned;
    if (folder.kind === "player") return () => listPlayer(folder.player.playerIds);
    return listThisPlayer;
  }, [folder, listPlayer, listThisPlayer, listUnassigned]);
  const { clips, error: listError } = useClipListing(listFolder);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return players
      .filter((player) => player.playerName.toLowerCase().includes(needle))
      .sort((a, b) => a.playerName.localeCompare(b.playerName))
      .slice(0, 20);
  }, [players, query]);

  const pick = async (id: string) => {
    setLoadingId(id);
    setPickError("");
    try {
      await onPick(id);
    } catch (reason) {
      setPickError(loadErrorMessage(reason));
      setLoadingId(null);
    }
  };

  const openFolder = (next: Folder) => {
    setQuery("");
    setFolder(next);
  };

  const renderClips = (list: readonly LibraryClip[]) => (
    <ul className="library-clip-list">
      {list.map((clip) => (
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
  );

  const renderFolderBody = () => {
    if (clips === null) return <p className="library-clip-note">{t("Loading the library…")}</p>;
    if (folder.kind !== "home") {
      return clips.length ? renderClips(clips) : <p className="library-clip-note">{t("No saved videos here yet.")}</p>;
    }
    if (!playerName) return null;
    const likely = clips.filter((clip) => clip.likely);
    const rest = clips.filter((clip) => !clip.likely);
    return (
      <>
        {likely.length ? (
          <>
            <h3 className="library-clip-section">{t("Likely pairings")}</h3>
            {renderClips(likely)}
          </>
        ) : null}
        <h3 className="library-clip-section">{playerName}</h3>
        {rest.length ? (
          renderClips(rest)
        ) : (
          <p className="library-clip-note">
            {likely.length ? t("No other saved videos for this player.") : t("No saved videos for this player yet.")}
          </p>
        )}
      </>
    );
  };

  const error = pickError || listError;

  return (
    <section className="library-clip-panel" aria-label={t("From library")}>
      <div className="library-clip-head">
        {folder.kind === "home" ? (
          <h2>{t("From library")}</h2>
        ) : (
          <button type="button" className="upload-button is-subtle" onClick={() => openFolder({ kind: "home" })}>
            ← {folder.kind === "unassigned" ? t("Unassigned") : folder.player.playerName}
          </button>
        )}
        <button type="button" className="upload-button is-subtle" onClick={onClose}>
          {t("Close")}
        </button>
      </div>
      <input
        type="search"
        className="library-clip-search"
        placeholder={t("Search players")}
        aria-label={t("Search players")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {error ? (
        <p className="video-upload-error" role="alert">
          {error}
        </p>
      ) : null}
      {query.trim() ? (
        matches.length ? (
          <ul className="library-clip-list">
            {matches.map((player) => (
              <li key={player.playerIds.join("|")}>
                <button
                  type="button"
                  className="library-clip-folder"
                  onClick={() => openFolder({ kind: "player", player })}
                >
                  {player.playerName}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="library-clip-note">{t("No players match.")}</p>
        )
      ) : (
        <>
          {renderFolderBody()}
          {folder.kind === "home" ? (
            <button
              type="button"
              className="library-clip-folder"
              onClick={() => openFolder({ kind: "unassigned" })}
            >
              {t("Unassigned")}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
