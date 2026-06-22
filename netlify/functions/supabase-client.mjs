function env(name, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function cleanUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

export function getSupabaseConfig(purpose = "Supabase") {
  const url = cleanUrl(env("SUPABASE_URL"));
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  const missing = [];
  if (!url) missing.push("SUPABASE_URL");
  if (!key) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length) {
    throw new Error(`${purpose} is not configured. Missing Netlify environment variable(s): ${missing.join(", ")}.`);
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${purpose} is not configured. SUPABASE_URL is not a valid URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${purpose} is not configured. SUPABASE_URL must use https.`);
  }

  return { url, key };
}

export function supabaseEnvStatus() {
  const url = cleanUrl(env("SUPABASE_URL"));
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const legacyServiceKey = env("SUPABASE_SERVICE_KEY");
  return {
    SUPABASE_URL: Boolean(url),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(serviceRoleKey),
    SUPABASE_SERVICE_KEY: Boolean(legacyServiceKey),
    serviceKeySource: serviceRoleKey ? "SUPABASE_SERVICE_ROLE_KEY" : legacyServiceKey ? "SUPABASE_SERVICE_KEY" : "missing",
  };
}

export async function supabaseRequest(table, options = {}) {
  const { url, key } = getSupabaseConfig(options.purpose || "Supabase");
  const method = options.method || "GET";
  const response = await fetch(`${url}/rest/v1/${table}${options.query ? `?${options.query}` : ""}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.prefer ? { Prefer: options.prefer } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase ${method} ${table} failed ${response.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : [];
}
