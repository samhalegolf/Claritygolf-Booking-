const originalFetch = window.fetch.bind(window);

window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();

  if (method === "POST" && url.endsWith("/api/people/import")) {
    const nextInput = typeof input === "string" ? "/api/people/import-lite" : new URL("/api/people/import-lite", window.location.origin);
    return originalFetch(nextInput, init);
  }

  return originalFetch(input, init);
};
