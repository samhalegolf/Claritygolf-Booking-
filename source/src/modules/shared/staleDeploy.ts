// A tab left open across a deploy still holds the old index, so the first lazy
// panel it opens asks for a hashed chunk the new deploy no longer serves. The
// import rejects, and without this the whole tree unmounts to a white page.
// A reload fetches the new index and the new hashes, which is all it needs.
//
// The guard stops a loop: if the chunk is still missing straight after a
// reload, it is not a stale tab, and the error boundary shows it instead.

const RELOAD_KEY = "clarity.staleDeployReloadAt";
const RELOAD_WINDOW_MS = 30_000;

function reloadedRecently() {
  try {
    const at = Number(window.sessionStorage.getItem(RELOAD_KEY) || 0);
    return Date.now() - at < RELOAD_WINDOW_MS;
  } catch {
    // No storage, no guard -- so no automatic reload either.
    return true;
  }
}

/** Reloads once for a stale-deploy chunk failure. False when the guard declines. */
export function reloadForStaleDeploy() {
  if (reloadedRecently()) return false;
  try {
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** The ways a browser says a dynamic import could not be fetched. */
export function isChunkLoadError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /dynamically imported module|Importing a module script failed|Failed to load module script|error loading dynamically imported module/i.test(
    message,
  );
}

export function installStaleDeployReload() {
  // Vite fires this for both a failed preload and a failed import. Cancelling
  // it stops Vite rethrowing, which only matters when the reload is under way.
  window.addEventListener("vite:preloadError", (event) => {
    console.warn("stale_deploy_chunk_failed", { error: (event as Event & { payload?: unknown }).payload });
    if (reloadForStaleDeploy()) event.preventDefault();
  });
}
