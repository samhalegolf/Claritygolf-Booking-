// Documentation-only guardrail: this direct Supabase helper is part of the
// active source/ app's Supabase-backed persistence path.
// source/package.json also intentionally aliases @netlify/database to
// source/netlify/functions/local-db, where booking-core.mts reaches Supabase
// through a getDatabase() compatibility shim.
// Keep this direct helper and the local-db Supabase adapter in sync until a
// later explicit refactor consolidates adapter imports. Do not mistake
// @netlify/database or local-db naming for Netlify Database or SQLite-backed
// production persistence; production persistence is Supabase REST using
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY.
function env(name, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeSql(sql) {
  return String(sql || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildSql(strings, values) {
  let text = "";
  strings.forEach((part, index) => {
    text += part;
    if (index < values.length) text += `$${index + 1}`;
  });
  return { text, values };
}

function encodeFilter(value) {
  return encodeURIComponent(String(value ?? ""));
}

function cleanRow(row) {
  return Object.fromEntries(
    Object.entries(row || {}).filter(([, value]) => value !== undefined),
  );
}

const OPTIONAL_CALENDAR_ITEM_COLUMNS = new Set(["status", "custom_group"]);

function missingOptionalCalendarItemColumn(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (!/calendar_items/i.test(message)) return "";
  if (!/(schema cache|column|PGRST204|42703|Could not find)/i.test(message)) return "";
  for (const column of OPTIONAL_CALENDAR_ITEM_COLUMNS) {
    const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`['"\`]${escaped}['"\`]|\\b${escaped}\\b`, "i").test(message)) return column;
  }
  return "";
}

function omitCalendarItemColumn(rows, column) {
  return rows.map((row) => {
    const { [column]: _omitted, ...rest } = row;
    return rest;
  });
}

async function upsertCalendarItemsAccepting(store, rows) {
  let nextRows = rows;
  const omittedColumns = [];

  while (true) {
    try {
      await store.upsert("calendar_items", nextRows, "id");
      return omittedColumns;
    } catch (error) {
      const column = missingOptionalCalendarItemColumn(error);
      if (!column || omittedColumns.includes(column)) throw error;
      omittedColumns.push(column);
      nextRows = omitCalendarItemColumn(nextRows, column);
      console.warn("supabase_storage:calendar_items_optional_column_omitted", {
        column,
        error: error instanceof Error ? error.message : String(error || ""),
      });
    }
  }
}

class SupabaseRestStore {
  constructor() {
    this.url = env("SUPABASE_URL").replace(/\/$/, "");
    this.key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
    if (!this.url || !this.key) {
      throw new Error(
        "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Netlify.",
      );
    }
  }

  tableUrl(table, query = "") {
    return `${this.url}/rest/v1/${table}${query ? `?${query}` : ""}`;
  }

  async request(table, { method = "GET", query = "", body, prefer = "" } = {}) {
    const response = await fetch(this.tableUrl(table, query), {
      method,
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Supabase ${method} ${table} failed ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    if (!text) return [];
    return JSON.parse(text);
  }

  async select(table, query = "") {
    return this.request(table, { query });
  }

  async insert(table, rows, { returning = false } = {}) {
    return this.request(table, {
      method: "POST",
      body: rows,
      prefer: returning ? "return=representation" : "return=minimal",
    });
  }

  async upsert(
    table,
    rows,
    onConflict,
    { ignore = false, returning = false } = {},
  ) {
    const prefer = [
      ignore ? "resolution=ignore-duplicates" : "resolution=merge-duplicates",
      returning ? "return=representation" : "return=minimal",
    ].join(",");
    return this.request(table, {
      method: "POST",
      query: `on_conflict=${encodeURIComponent(onConflict)}`,
      body: rows,
      prefer,
    });
  }

  async update(table, query, patch, { returning = false } = {}) {
    return this.request(table, {
      method: "PATCH",
      query,
      body: cleanRow(patch),
      prefer: returning ? "return=representation" : "return=minimal",
    });
  }

  async delete(table, query) {
    return this.request(table, {
      method: "DELETE",
      query,
      prefer: "return=minimal",
    });
  }

  async savePerson(row) {
    const email = String(row?.email || "").toLowerCase();
    if (email) {
      const existing = await this.select("people", `select=id,email&email=eq.${encodeFilter(email)}&limit=1`);
      const existingId = existing[0]?.id || "";
      if (existingId) {
        await this.upsert("people", [{ ...row, id: existingId, email }], "id");
        return;
      }
    }
    await this.upsert("people", [{ ...row, email: email || row.email }], "id");
  }

  async query(sqlText, values = []) {
    const sql = normalizeSql(sqlText);
    if (
      !sql ||
      sql.startsWith("create table") ||
      sql.startsWith("create index") ||
      sql.startsWith("create unique index") ||
      sql.startsWith("drop index") ||
      sql.startsWith("alter table")
    ) {
      return [];
    }
    if (sql === "begin" || sql === "commit" || sql === "rollback") {
      return { rows: [] };
    }

    if (sql.includes("insert into settings")) {
      const [key, value] = values;
      if (sql.includes("do nothing")) {
        await this.upsert(
          "settings",
          [{ key, value: String(value ?? ""), updated_at: nowIso() }],
          "key",
          { ignore: true },
        );
      } else {
        await this.upsert(
          "settings",
          [{ key, value: String(value ?? ""), updated_at: nowIso() }],
          "key",
        );
      }
      return [];
    }
    if (sql.startsWith("select value from settings")) {
      return this.select(
        "settings",
        `select=value&key=eq.${encodeFilter(values[0])}`,
      );
    }
    if (sql.startsWith("select count(*) as count from calendar_items")) {
      const rows = await this.select("calendar_items", "select=id");
      return [{ count: rows.length }];
    }

    if (sql.startsWith("select * from calendar_items")) {
      return this.select(
        "calendar_items",
        "select=*&order=week.asc,day.asc,start.asc,id.asc",
      );
    }
    if (sql === "delete from calendar_items") {
      await this.delete("calendar_items", "id=not.is.null");
      return { rows: [] };
    }
    if (sql.includes("insert into calendar_items")) {
      await upsertCalendarItemsAccepting(this, [calendarItemFromParams(values)]);
      return { rows: [] };
    }

    if (sql.startsWith("select * from people")) {
      return this.select("people", "select=*&order=name.asc,email.asc,id.asc");
    }
    if (sql.startsWith("select count(*) as count from people")) {
      const rows = await this.select("people", "select=id");
      return [{ count: rows.length }];
    }
    if (sql === "select id from people where id = $1 limit 1") {
      const rows = await this.select(
        "people",
        `select=id&id=eq.${encodeFilter(values[0])}&limit=1`,
      );
      return { rows };
    }
    if (
      sql === "select id from people where lower(email) = lower($1) limit 1"
    ) {
      const rows = await this.select(
        "people",
        `select=id&email=eq.${encodeFilter(String(values[0] || "").toLowerCase())}&limit=1`,
      );
      return { rows };
    }
    if (
      sql ===
      "select id from people where lower(name) = lower($1) and phone = $2 limit 1"
    ) {
      const rows = await this.select(
        "people",
        `select=id&name=eq.${encodeFilter(values[0])}&phone=eq.${encodeFilter(values[1])}&limit=1`,
      );
      return { rows };
    }
    if (sql.includes("insert into people")) {
      const row = personFromParams(values);
      await this.savePerson(row);
      return { rows: [] };
    }
    if (sql.startsWith("update people")) {
      await this.update(
        "people",
        `id=eq.${encodeFilter(values[0])}`,
        personPatchFromParams(values),
      );
      return { rows: [] };
    }
    if (sql === "select * from people where id = $1 limit 1") {
      const rows = await this.select(
        "people",
        `select=*&id=eq.${encodeFilter(values[0])}&limit=1`,
      );
      return { rows };
    }

    if (sql.startsWith("select id from admin_users where email = $1")) {
      return this.select(
        "admin_users",
        `select=id&email=eq.${encodeFilter(values[0])}`,
      );
    }
    if (sql.startsWith("select * from admin_users where email = $1")) {
      return this.select(
        "admin_users",
        `select=*&email=eq.${encodeFilter(values[0])}`,
      );
    }
    if (
      sql.startsWith(
        "select id, email, password_hash, password_salt from admin_users where id = $1",
      )
    ) {
      return this.select(
        "admin_users",
        `select=id,email,password_hash,password_salt&id=eq.${encodeFilter(values[0])}&limit=1`,
      );
    }
    if (
      sql.startsWith(
        "select id, email from admin_users where lower(email) = lower($1)",
      )
    ) {
      return this.select(
        "admin_users",
        `select=id,email&email=eq.${encodeFilter(String(values[0] || "").toLowerCase())}&limit=1`,
      );
    }
    if (sql.includes("insert into admin_users")) {
      const [id, email, password_hash, password_salt] = values;
      await this.upsert(
        "admin_users",
        [
          {
            id,
            email,
            password_hash,
            password_salt,
            created_at: nowIso(),
            updated_at: nowIso(),
          },
        ],
        "email",
        { ignore: true },
      );
      return [];
    }
    if (sql.startsWith("update admin_users")) {
      const filter = sql.includes("where email")
        ? `email=eq.${encodeFilter(values[2])}`
        : `id=eq.${encodeFilter(values[2] || values[0])}`;
      await this.update("admin_users", filter, {
        password_hash: values[0],
        password_salt: values[1],
        updated_at: nowIso(),
      });
      return { rows: [] };
    }

    if (sql.includes("insert into admin_sessions")) {
      const [id, token_hash, user_id, expires_at] = values;
      await this.insert("admin_sessions", [
        { id, token_hash, user_id, expires_at, created_at: nowIso() },
      ]);
      return [];
    }
    if (sql.includes("from admin_sessions join admin_users")) {
      return this.adminSessionRows(
        values[0],
        sql.includes("admin_sessions.expires_at > now()") ? "reset" : "session",
      );
    }
    if (sql.includes("from admin_password_resets join admin_users")) {
      return this.adminSessionRows(values[0], "reset");
    }
    if (sql.startsWith("delete from admin_sessions where token_hash")) {
      await this.delete(
        "admin_sessions",
        `token_hash=eq.${encodeFilter(values[0])}`,
      );
      return [];
    }
    if (sql.startsWith("delete from admin_sessions where expires_at")) {
      await this.delete(
        "admin_sessions",
        `expires_at=lte.${encodeFilter(nowIso())}`,
      );
      return [];
    }
    if (sql.startsWith("delete from admin_sessions where user_id")) {
      await this.delete(
        "admin_sessions",
        `user_id=eq.${encodeFilter(values[0])}`,
      );
      return { rows: [] };
    }

    if (sql.startsWith("delete from admin_password_resets")) {
      await this.delete(
        "admin_password_resets",
        `or=(expires_at.lte.${encodeFilter(nowIso())},used_at.not.is.null)`,
      );
      return [];
    }
    if (sql.includes("insert into admin_password_resets")) {
      const [id, token_hash, user_id, expires_at] = values;
      await this.insert("admin_password_resets", [
        { id, token_hash, user_id, expires_at, created_at: nowIso() },
      ]);
      return [];
    }
    if (sql.startsWith("update admin_password_resets set used_at")) {
      await this.update(
        "admin_password_resets",
        `id=eq.${encodeFilter(values[0])}`,
        { used_at: nowIso() },
      );
      return { rows: [] };
    }

    if (sql.startsWith("select * from notification_history")) {
      return this.select(
        "notification_history",
        "select=*&order=created_at.desc&limit=500",
      );
    }
    if (sql.includes("insert into notification_history")) {
      const [
        id,
        person_key,
        calendar_item_id,
        recipient,
        subject,
        kind,
        status,
        provider,
        provider_id,
        error,
      ] = values;
      await this.insert("notification_history", [
        {
          id,
          person_key,
          calendar_item_id,
          recipient,
          subject,
          kind,
          status,
          provider,
          provider_id,
          error,
          created_at: nowIso(),
        },
      ]);
      return [];
    }
    if (
      sql.startsWith(
        "select id, status, error from notification_history where provider_id",
      )
    ) {
      return this.select(
        "notification_history",
        `select=id,status,error&provider_id=eq.${encodeFilter(values[0])}`,
      );
    }
    if (sql.startsWith("update notification_history set status")) {
      await this.update(
        "notification_history",
        `id=eq.${encodeFilter(values[2])}`,
        {
          status: values[0],
          ...(values[1] ? { error: values[1] } : {}),
        },
      );
      return [];
    }

    if (sql.startsWith("select id from notification_webhook_events")) {
      return this.select(
        "notification_webhook_events",
        `select=id&id=eq.${encodeFilter(values[0])}&limit=1`,
      );
    }
    if (sql.includes("insert into notification_webhook_events")) {
      const [id, provider_id, event_type, payload] = values;
      await this.upsert(
        "notification_webhook_events",
        [{ id, provider_id, event_type, payload, received_at: nowIso() }],
        "id",
        { ignore: true },
      );
      return [];
    }

    throw new Error(
      `Unsupported Supabase storage query: ${sqlText.slice(0, 240)}`,
    );
  }

  async adminSessionRows(tokenOrResetHash, mode) {
    if (mode === "reset") {
      const resets = await this.select(
        "admin_password_resets",
        `select=*&token_hash=eq.${encodeFilter(tokenOrResetHash)}&used_at=is.null&expires_at=gt.${encodeFilter(nowIso())}&limit=1`,
      );
      const reset = resets[0];
      if (!reset) return [];
      const users = await this.select(
        "admin_users",
        `select=id,email&id=eq.${encodeFilter(reset.user_id)}&limit=1`,
      );
      const user = users[0];
      return user
        ? [{ reset_id: reset.id, user_id: user.id, email: user.email }]
        : [];
    }

    const sessions = await this.select(
      "admin_sessions",
      `select=*&token_hash=eq.${encodeFilter(tokenOrResetHash)}&limit=1`,
    );
    const session = sessions[0];
    if (!session) return [];
    const users = await this.select(
      "admin_users",
      `select=id,email&id=eq.${encodeFilter(session.user_id)}&limit=1`,
    );
    const user = users[0];
    return user
      ? [{ id: user.id, email: user.email, expires_at: session.expires_at }]
      : [];
  }
}

function calendarItemFromParams(values) {
  const [
    id,
    kind,
    week,
    day,
    start,
    duration,
    service_id,
    client,
    title,
    phone,
    email,
    note,
    status,
    custom_group,
  ] = values;
  return cleanRow({
    id,
    kind,
    week,
    day,
    start,
    duration,
    service_id,
    client,
    title,
    phone,
    email,
    note,
    status: status || "booked",
    custom_group: custom_group ? JSON.parse(custom_group) : null,
    created_at: nowIso(),
    updated_at: nowIso(),
  });
}

function personFromParams(values) {
  const [
    id,
    name,
    email,
    phone,
    notes,
    source,
    caddy_profile_id,
    caddy_profile_url,
  ] = values;
  return cleanRow({
    id,
    name,
    email: email || null,
    phone: phone || null,
    notes: notes || null,
    source,
    caddy_profile_id: caddy_profile_id || null,
    caddy_profile_url: caddy_profile_url || null,
    created_at: nowIso(),
    updated_at: nowIso(),
  });
}

function personPatchFromParams(values) {
  const [
    ,
    name,
    email,
    phone,
    notes,
    source,
    caddy_profile_id,
    caddy_profile_url,
  ] = values;
  return {
    name,
    email: email || null,
    phone: phone || null,
    notes: notes || null,
    source: source || null,
    caddy_profile_id: caddy_profile_id || null,
    caddy_profile_url: caddy_profile_url || null,
    updated_at: nowIso(),
  };
}

class SupabaseClientShim {
  constructor(store) {
    this.store = store;
  }

  async query(text, values = []) {
    const result = await this.store.query(text, values);
    return Array.isArray(result) ? { rows: result } : result;
  }

  release() {}
}

let cachedDatabase = null;

export function getSupabaseDatabase() {
  if (!cachedDatabase) {
    const store = new SupabaseRestStore();
    cachedDatabase = {
      sql(strings, ...values) {
        const built = buildSql(strings, values);
        return store.query(built.text, built.values);
      },
      pool: {
        async connect() {
          return new SupabaseClientShim(store);
        },
      },
    };
  }
  return cachedDatabase;
}
