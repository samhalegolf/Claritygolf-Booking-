(() => {
  if (window.__clarityCalendarReliabilityGuardInstalled) return;
  window.__clarityCalendarReliabilityGuardInstalled = true;

  const originalFetch = window.fetch.bind(window);
  let calendarQueue = Promise.resolve();
  let latestCalendarVersion = "";

  function calendarPath(input) {
    try {
      const value = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      return new URL(value, window.location.href).pathname;
    } catch {
      return "";
    }
  }

  function cleanItem(item) {
    return {
      id: String(item?.id || ""),
      kind: item?.kind === "block" ? "block" : "appointment",
      week: Number(item?.week || 0),
      day: Number(item?.day || 0),
      start: Number(item?.start || 0),
      duration: Number(item?.duration || 0),
      serviceId: String(item?.serviceId || ""),
      client: String(item?.client || ""),
      title: String(item?.title || ""),
      phone: String(item?.phone || ""),
      email: String(item?.email || "").trim().toLowerCase(),
      note: String(item?.note || ""),
    };
  }

  function itemsFingerprint(items) {
    return JSON.stringify((Array.isArray(items) ? items : []).map(cleanItem).sort((a, b) => a.id.localeCompare(b.id)));
  }

  async function responseJson(response) {
    try {
      return await response.clone().json();
    } catch {
      return {};
    }
  }

  function syntheticJson(data, status = 200, statusText = "OK") {
    return new Response(JSON.stringify(data), {
      status,
      statusText,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  function sanitizeSaveResponse(response, data) {
    const safe = data && typeof data === "object" ? { ...data } : {};
    // React already holds the exact local snapshot. Returning the same items
    // caused a state write -> autosave -> state write loop.
    delete safe.items;
    return syntheticJson(safe, response.status, response.statusText || "OK");
  }

  async function readLiveCalendar() {
    const response = await originalFetch("/api/calendar-state", {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });
    const data = await responseJson(response);
    if (response.ok && typeof data.updatedAt === "string") latestCalendarVersion = data.updatedAt;
    return { response, data };
  }

  async function executeCalendarSave(input, init = {}) {
    let payload;
    try {
      payload = typeof init.body === "string" ? JSON.parse(init.body) : {};
    } catch {
      payload = {};
    }
    const requestedFingerprint = itemsFingerprint(payload.items);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (latestCalendarVersion) payload.updatedAt = latestCalendarVersion;
      try {
        const response = await originalFetch(input, {
          ...init,
          body: JSON.stringify(payload),
          credentials: init.credentials || "same-origin",
          cache: "no-store",
        });
        const data = await responseJson(response);
        if (response.ok) {
          if (typeof data.updatedAt === "string") latestCalendarVersion = data.updatedAt;
          return sanitizeSaveResponse(response, data);
        }

        // A request can reach the server and then lose its response on mobile.
        // If the live read proves the exact snapshot is present, report success.
        if (response.status >= 500 || response.status === 409) {
          const live = await readLiveCalendar().catch(() => null);
          if (live?.response.ok && itemsFingerprint(live.data.items) === requestedFingerprint) {
            return syntheticJson({ ...live.data, items: undefined, recovered: true });
          }
          if (response.status === 409) return response;
        }
        if (attempt === 2) return response;
      } catch (error) {
        const live = await readLiveCalendar().catch(() => null);
        if (live?.response.ok && itemsFingerprint(live.data.items) === requestedFingerprint) {
          const recovered = { ...live.data, recovered: true };
          delete recovered.items;
          return syntheticJson(recovered);
        }
        if (attempt === 2) throw error;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
    }
    throw new Error("Calendar save failed after retry.");
  }

  window.fetch = (input, init = {}) => {
    const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (calendarPath(input) !== "/api/calendar-state" || method !== "PUT") {
      return originalFetch(input, init);
    }

    // Serialize saves. Each queued body is upgraded to the version returned by
    // the previous save, preventing stale-version races during rapid dragging.
    const task = calendarQueue.catch(() => undefined).then(() => executeCalendarSave(input, init));
    calendarQueue = task.then(() => undefined, () => undefined);
    return task;
  };
})();
