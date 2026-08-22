import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import "./practice.css";
import {
  createPracticeCategory,
  createPracticeSubcategory,
  practiceBlockTitle,
  removePracticeCategory,
  removePracticeSubcategory,
  type PracticeBlock,
  type PracticeCategory,
} from "./practiceModel";

/* The coach's end of the Practice section.
 *
 * Prescribing is three moves: pick what kind of practice this is, pick where
 * it happens, write what to do. The first two make the title -- "Drill · At
 * home" -- so the coach never types a heading, and the same headings come back
 * every time rather than being retyped slightly differently.
 *
 * The category library is built from inside this form rather than in a
 * settings screen somewhere else. A coach who needs a heading needs it while
 * they are writing the block, not on a separate trip.
 */

const NEW_OPTION = "__new__";

export type PracticeFeederProps = {
  player: { id: string; name: string };
  /** Called on a 401 so the app can drop back to its signed-out state. */
  onUnauthorized: () => void;
  onToast: (message: string) => void;
};

export function PracticeFeeder({ player, onUnauthorized, onToast }: PracticeFeederProps) {
  const [categories, setCategories] = useState<PracticeCategory[]>([]);
  const [blocks, setBlocks] = useState<PracticeBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [categoryId, setCategoryId] = useState("");
  const [subcategoryId, setSubcategoryId] = useState("");
  const [body, setBody] = useState("");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newSubcategoryName, setNewSubcategoryName] = useState("");
  const [editingLibrary, setEditingLibrary] = useState(false);

  const request = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const response = await fetch(path, {
        credentials: "same-origin",
        cache: "no-store",
        ...init,
        headers: { Accept: "application/json", ...(init.headers || {}) },
      });
      if (response.status === 401) {
        onUnauthorized();
        throw new Error("Admin login required");
      }
      const data = (await response.json().catch(() => ({}))) as {
        message?: string;
        categories?: PracticeCategory[];
        blocks?: PracticeBlock[];
      };
      if (!response.ok) throw new Error(data?.message || "Practice request failed.");
      return data;
    },
    [onUnauthorized],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [library, prescribed] = await Promise.all([
        request("/api/practice/categories"),
        request(`/api/practice?playerId=${encodeURIComponent(player.id)}`),
      ]);
      setCategories(Array.isArray(library.categories) ? library.categories : []);
      setBlocks(Array.isArray(prescribed.blocks) ? prescribed.blocks : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load practice.");
    } finally {
      setLoading(false);
    }
  }, [player.id, request]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveLibrary = useCallback(
    async (next: PracticeCategory[]) => {
      // Optimistic: the library is the coach's own list and a failed save puts
      // the server's copy straight back.
      setCategories(next);
      try {
        const data = await request("/api/practice/categories", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ categories: next }),
        });
        if (Array.isArray(data.categories)) setCategories(data.categories);
        return true;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not save categories.");
        // Put the server's copy back, but without going through load() -- that
        // raises the loading flag and replaces the half-filled form with a
        // spinner, losing what the coach had already typed.
        try {
          const data = await request("/api/practice/categories");
          if (Array.isArray(data.categories)) setCategories(data.categories);
        } catch {
          // Already reporting the first failure; a second message helps nobody.
        }
        return false;
      }
    },
    [request],
  );

  const selectedCategory = useMemo(
    () => categories.find((category) => category.id === categoryId) || null,
    [categories, categoryId],
  );

  // A sub-category belongs to its parent -- "At home" under Drill is not the
  // same list as "At home" under Play -- so changing the category clears it.
  useEffect(() => {
    if (subcategoryId === NEW_OPTION) return;
    if (!selectedCategory?.subcategories.some((sub) => sub.id === subcategoryId)) {
      setSubcategoryId("");
    }
  }, [selectedCategory, subcategoryId]);

  const addCategory = useCallback(async () => {
    const name = newCategoryName.trim();
    if (!name) return;
    const { categories: next, created } = createPracticeCategory(categories, name);
    setNewCategoryName("");
    setCategoryId(created.id);
    setSubcategoryId("");
    await saveLibrary(next);
  }, [categories, newCategoryName, saveLibrary]);

  const addSubcategory = useCallback(async () => {
    const name = newSubcategoryName.trim();
    if (!name || !selectedCategory) return;
    const { categories: next, created } = createPracticeSubcategory(
      categories,
      selectedCategory.id,
      name,
    );
    setNewSubcategoryName("");
    setSubcategoryId(created.id);
    await saveLibrary(next);
  }, [categories, newSubcategoryName, saveLibrary, selectedCategory]);

  const prescribe = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const description = body.trim();
      if (!description || !selectedCategory || busy) return;
      const subcategory =
        selectedCategory.subcategories.find((sub) => sub.id === subcategoryId) || null;
      setBusy(true);
      setError("");
      try {
        const data = await request("/api/practice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            block: {
              playerId: player.id,
              playerName: player.name,
              categoryId: selectedCategory.id,
              categoryName: selectedCategory.name,
              subcategoryId: subcategory?.id || "",
              subcategoryName: subcategory?.name || "",
              body: description,
            },
          }),
        });
        if (Array.isArray(data.blocks)) {
          setBlocks(data.blocks.filter((block) => block.playerId === player.id));
        }
        setBody("");
        onToast(`Practice prescribed for ${player.name}.`);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not prescribe that.");
      } finally {
        setBusy(false);
      }
    },
    [body, busy, onToast, player.id, player.name, request, selectedCategory, subcategoryId],
  );

  const removeBlock = useCallback(
    async (blockId: string) => {
      setBusy(true);
      setError("");
      try {
        const data = await request(`/api/practice?id=${encodeURIComponent(blockId)}`, {
          method: "DELETE",
        });
        if (Array.isArray(data.blocks)) {
          setBlocks(data.blocks.filter((block) => block.playerId === player.id));
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not remove that block.");
      } finally {
        setBusy(false);
      }
    },
    [player.id, request],
  );

  if (loading) return <div className="module-loading">Loading practice…</div>;

  const creatingCategory = categoryId === NEW_OPTION;
  const creatingSubcategory = subcategoryId === NEW_OPTION;

  return (
    <div className="practice-feeder">
      <form className="practice-prescribe" onSubmit={prescribe}>
        <div className="practice-pickers">
          <label className="practice-field">
            <span>Category</span>
            <select
              value={categoryId}
              onChange={(event) => {
                setCategoryId(event.target.value);
                setSubcategoryId("");
              }}
            >
              <option value="">Choose…</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
              <option value={NEW_OPTION}>+ New category…</option>
            </select>
          </label>

          <label className="practice-field">
            <span>Sub-category</span>
            <select
              value={subcategoryId}
              disabled={!selectedCategory}
              onChange={(event) => setSubcategoryId(event.target.value)}
            >
              <option value="">{selectedCategory ? "Choose…" : "Pick a category first"}</option>
              {selectedCategory?.subcategories.map((sub) => (
                <option key={sub.id} value={sub.id}>
                  {sub.name}
                </option>
              ))}
              {selectedCategory && <option value={NEW_OPTION}>+ New sub-category…</option>}
            </select>
          </label>
        </div>

        {creatingCategory && (
          <div className="practice-inline-add">
            <input
              value={newCategoryName}
              onChange={(event) => setNewCategoryName(event.target.value)}
              placeholder="Drill"
              aria-label="New category name"
              autoFocus
            />
            <button
              type="button"
              className="primary-button"
              disabled={!newCategoryName.trim()}
              onClick={() => void addCategory()}
            >
              Add category
            </button>
            <button type="button" className="outline-button" onClick={() => setCategoryId("")}>
              Cancel
            </button>
          </div>
        )}

        {creatingSubcategory && selectedCategory && (
          <div className="practice-inline-add">
            <input
              value={newSubcategoryName}
              onChange={(event) => setNewSubcategoryName(event.target.value)}
              placeholder="At home"
              aria-label={`New sub-category under ${selectedCategory.name}`}
              autoFocus
            />
            <button
              type="button"
              className="primary-button"
              disabled={!newSubcategoryName.trim()}
              onClick={() => void addSubcategory()}
            >
              Add sub-category
            </button>
            <button type="button" className="outline-button" onClick={() => setSubcategoryId("")}>
              Cancel
            </button>
          </div>
        )}

        <label className="practice-field">
          <span>What to practise</span>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={4}
            placeholder="Ten balls, alignment stick down the target line. Stop if the strike goes."
          />
        </label>

        <div className="practice-prescribe-actions">
          <span className="practice-preview">
            {selectedCategory && !creatingCategory
              ? practiceBlockTitle({
                  categoryName: selectedCategory.name,
                  subcategoryName:
                    selectedCategory.subcategories.find((sub) => sub.id === subcategoryId)?.name || "",
                })
              : "Pick a category to title this block"}
          </span>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || !body.trim() || !selectedCategory || creatingCategory}
          >
            Prescribe
          </button>
        </div>

        {error && (
          <p className="practice-error" role="alert">
            {error}
          </p>
        )}
      </form>

      {categories.length > 0 && (
        <div className="practice-library">
          <button
            type="button"
            className="practice-library-toggle"
            aria-expanded={editingLibrary}
            onClick={() => setEditingLibrary((current) => !current)}
          >
            {editingLibrary ? "Done editing categories" : "Edit categories"}
          </button>
          {editingLibrary && (
            <div className="practice-library-body">
              {/* Removing a category does not touch the blocks already
                  prescribed under it -- they keep the name they were filed
                  with, so old practice stays readable. */}
              <p className="practice-library-note">
                Blocks already prescribed keep their title if you remove a category here.
              </p>
              {categories.map((category) => (
                <div className="practice-library-row" key={category.id}>
                  <div className="practice-library-head">
                    <strong>{category.name}</strong>
                    <button
                      type="button"
                      className="practice-remove"
                      aria-label={`Remove category ${category.name}`}
                      onClick={() => void saveLibrary(removePracticeCategory(categories, category.id))}
                    >
                      Remove
                    </button>
                  </div>
                  <div className="practice-library-subs">
                    {category.subcategories.length ? (
                      category.subcategories.map((sub) => (
                        <span className="practice-chip" key={sub.id}>
                          {sub.name}
                          <button
                            type="button"
                            aria-label={`Remove sub-category ${sub.name}`}
                            onClick={() =>
                              void saveLibrary(
                                removePracticeSubcategory(categories, category.id, sub.id),
                              )
                            }
                          >
                            ×
                          </button>
                        </span>
                      ))
                    ) : (
                      <span className="practice-library-empty">No sub-categories yet</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="practice-block-list">
        {blocks.length ? (
          blocks.map((block) => (
            <article className="practice-block-card" key={block.id}>
              <div>
                <strong>{practiceBlockTitle(block)}</strong>
                <span>{new Date(block.updatedAt || block.createdAt).toLocaleDateString()}</span>
              </div>
              <p>{block.body}</p>
              <button
                type="button"
                className="outline-button"
                disabled={busy}
                onClick={() => void removeBlock(block.id)}
              >
                Remove
              </button>
            </article>
          ))
        ) : (
          <p className="notes-empty">No practice prescribed yet.</p>
        )}
      </div>
    </div>
  );
}

export default PracticeFeeder;
