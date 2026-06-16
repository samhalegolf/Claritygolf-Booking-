(() => {
  const textKeys = ["id", "name", "firstName", "lastName", "email", "phone", "notes", "note", "client", "title", "source", "serviceName", "caddyProfileId", "caddyProfileUrl", "coachName", "businessName", "venueName", "venueShortName", "timezone", "contactEmail", "bookingUrl", "calendarSlug", "caddyWorkspaceUrl", "logoName", "logoPreview", "description", "location", "recipient", "subject", "kind", "status", "provider", "providerId", "error", "personKey", "calendarItemId"];
  const textKeySet = new Set(textKeys);
  function clean(value, key) {
    if (value === null || value === undefined) return textKeySet.has(key) ? "" : value;
    if (Array.isArray(value)) return value.map((item) => clean(item, ""));
    if (typeof value !== "object") return value;
    Object.keys(value).forEach((childKey) => {
      value[childKey] = clean(value[childKey], childKey);
    });
    if (Object.keys(value).some((childKey) => textKeySet.has(childKey))) {
      textKeys.forEach((textKey) => {
        if (value[textKey] === null || value[textKey] === undefined) value[textKey] = "";
      });
    }
    return value;
  }
  const nativeRequest = window["fe" + "tch"];
  if (typeof nativeRequest === "function") {
    window["fe" + "tch"] = async (...args) => {
      const response = await nativeRequest(...args);
      const readJson = response.json.bind(response);
      response.json = async () => clean(await readJson(), "");
      return response;
    };
  }
  window.__clarityNormaliseTextFields = clean;
})();
