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

const OPTIONAL_CALENDAR_ITEM_COLUMNS = new Set([
  "account_id",
  "status",
  "custom_group",
  "coach_id",
  "location_id",
  "coach",
  "location",
]);
const CALENDAR_ITEM_JSON_COLUMNS = new Set([
  "custom_group",
  "coach",
  "location",
]);
const CALENDAR_ITEM_ACCOUNT_SCOPE_COLUMNS = [
  "account_id",
  "coach_id",
  "location_id",
  "coach",
  "location",
];
const OPTIONAL_PEOPLE_COLUMNS = new Set(["account_id"]);

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

function missingOptionalPeopleColumn(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (!/people/i.test(message)) return "";
  if (!/(schema cache|column|PGRST204|42703|Could not find)/i.test(message)) return "";
  for (const column of OPTIONAL_PEOPLE_COLUMNS) {
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

function omitRowColumns(row, columns) {
  const omitted = new Set(columns);
  return Object.fromEntries(Object.entries(row || {}).filter(([key]) => !omitted.has(key)));
}

function omitCalendarItemColumns(rows, columns) {
  return columns.reduce(
    (nextRows, column) => omitCalendarItemColumn(nextRows, column),
    rows,
  );
}

function relatedMissingCalendarItemColumns(column) {
  return CALENDAR_ITEM_ACCOUNT_SCOPE_COLUMNS.includes(column)
    ? CALENDAR_ITEM_ACCOUNT_SCOPE_COLUMNS
    : [column];
}

function rememberMissingCalendarItemAccountScope(store, label, error) {
  if (missingOptionalCalendarItemColumn(error) !== "account_id") return false;
  const columns = relatedMissingCalendarItemColumns("account_id");
  store.omittedCalendarItemColumns ||= new Set();
  columns.forEach((column) => store.omittedCalendarItemColumns.add(column));
  console.warn("supabase_storage:calendar_items_account_scope_filter_omitted", {
    label,
    columns,
    error: error instanceof Error ? error.message : String(error || ""),
  });
  return true;
}

async function selectCalendarItemsWithAccountFallback(store, query, fallbackQuery, label) {
  try {
    return await store.select("calendar_items", query);
  } catch (error) {
    if (!rememberMissingCalendarItemAccountScope(store, label, error)) throw error;
    return store.select("calendar_items", fallbackQuery);
  }
}

async function deleteCalendarItemsWithAccountFallback(store, query, fallbackQuery, label) {
  try {
    await store.delete("calendar_items", query);
  } catch (error) {
    if (!rememberMissingCalendarItemAccountScope(store, label, error)) throw error;
    await store.delete("calendar_items", fallbackQuery);
  }
}

function parseJsonParam(value, column) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn("supabase_storage:calendar_items_json_param_ignored", {
      column,
      error: error instanceof Error ? error.message : String(error || ""),
    });
    return null;
  }
}

function calendarItemInsertColumns(sqlText) {
  const match = String(sqlText || "").match(/insert into calendar_items\s*\(([^)]+)\)/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);
}

function cleanIdList(values) {
  const rawValues = Array.isArray(values) ? values : [];
  if (rawValues.length === 0) return [];
  const candidates = rawValues.length === 1 && Array.isArray(rawValues[0]) ? rawValues[0] : rawValues;
  const parsePgTextArray = (text) => {
    const value = String(text ?? "").trim();
    if (!value.startsWith("{") || !value.endsWith("}")) return [value];
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => item.trim().replace(/^"|"$/g, ""));
  };

  const parsed = candidates.flatMap((candidate) => {
    if (candidate == null) return [];
    if (Array.isArray(candidate)) return candidate;
    if (typeof candidate === "string") return parsePgTextArray(candidate);
    return [candidate];
  });

  const unique = [];
  const seen = new Set();
  for (const value of parsed) {
    if (value == null) continue;
    const id = String(value).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

async function deleteCalendarItemsByIds(store, ids) {
  const idList = cleanIdList(ids);
  if (!idList.length) return [];
  await Promise.all(idList.map((id) => store.delete("calendar_items", `id=eq.${encodeFilter(id)}`)));
  return idList;
}

async function deleteCalendarItemsExceptIds(store, keepIds, accountId) {
  const keep = new Set(cleanIdList(keepIds));
  const filter = accountId ? `select=id&account_id=eq.${encodeFilter(accountId)}` : "select=id";
  const rows = accountId
    ? await selectCalendarItemsWithAccountFallback(
        store,
        filter,
        "select=id",
        "delete_except_ids",
      )
    : await store.select("calendar_items", filter);
  const idsToDelete = rows
    .map((row) => String(row?.id || ""))
    .map((id) => id.trim())
    .filter((id) => id && !keep.has(id));
  return deleteCalendarItemsByIds(store, idsToDelete);
}

async function upsertCalendarItemsAccepting(store, rows) {
  store.omittedCalendarItemColumns ||= new Set();
  const omittedColumns = [...store.omittedCalendarItemColumns];
  let nextRows = omittedColumns.length
    ? omitCalendarItemColumns(rows, omittedColumns)
    : rows;

  while (true) {
    try {
      await store.upsert("calendar_items", nextRows, "id");
      return omittedColumns;
    } catch (error) {
      const column = missingOptionalCalendarItemColumn(error);
      if (!column || omittedColumns.includes(column)) throw error;
      const columns = relatedMissingCalendarItemColumns(column).filter(
        (candidate) => !omittedColumns.includes(candidate),
      );
      columns.forEach((candidate) => {
        omittedColumns.push(candidate);
        store.omittedCalendarItemColumns.add(candidate);
      });
      nextRows = omitCalendarItemColumns(nextRows, columns);
      console.warn("supabase_storage:calendar_items_optional_column_omitted", {
        column,
        columns,
        error: error instanceof Error ? error.message : String(error || ""),
      });
    }
  }
}

function peopleRowWithKnownColumns(store, row) {
  store.omittedPeopleColumns ||= new Set();
  return omitRowColumns(row, store.omittedPeopleColumns);
}

// Only an email-uniqueness violation may be reported to the coach as a
// duplicate email. The previous test matched any 409 on PATCH people — and any
// "duplicate key" at all — so unrelated conflicts were blamed on the email
// field, sending coaches hunting for an address they never typed. Anything else
// now returns null and surfaces with its real message.
const PEOPLE_EMAIL_UNIQUE_CONSTRAINT =
  /idx_people_email_unique|idx_people_account_email_unique|people_email_key/i;

function peoplePatchDuplicateEmailError(error, query, patch) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (!PEOPLE_EMAIL_UNIQUE_CONSTRAINT.test(message)) return null;
  const idMatch = String(query || "").match(/(?:^|&)id=eq\.([^&]+)/);
  let personId = idMatch ? idMatch[1] : "";
  try {
    personId = decodeURIComponent(personId);
  } catch {
    // Keep the encoded id if it is not valid URI text.
  }
  const email = String(patch?.email || "").trim().toLowerCase();
  return Object.assign(new Error("Another person already uses that email address."), {
    status: 409,
    code: "DUPLICATE_PERSON_EMAIL",
    operationOwner: "people_patch",
    route: "PATCH people",
    personId,
    email,
    details: {
      operationOwner: "people_patch",
      route: "PATCH people",
      httpStatus: 409,
      personId,
      email,
      backendMessage: message.slice(0, 500),
    },
  });
}

async function upsertPersonAccepting(store, row) {
  let nextRow = peopleRowWithKnownColumns(store, row);
  while (true) {
    try {
      await store.upsert("people", [nextRow], "id");
      return;
    } catch (error) {
      const column = missingOptionalPeopleColumn(error);
      if (!column || store.omittedPeopleColumns?.has(column)) throw error;
      store.omittedPeopleColumns.add(column);
      nextRow = peopleRowWithKnownColumns(store, row);
      console.warn("supabase_storage:people_optional_column_omitted", {
        column,
        error: error instanceof Error ? error.message : String(error || ""),
      });
    }
  }
}

async function updatePeopleAccepting(store, query, patch) {
  let nextPatch = peopleRowWithKnownColumns(store, patch);
  while (true) {
    if (!Object.keys(nextPatch).length) return;
    try {
      await store.update("people", query, nextPatch);
      return;
    } catch (error) {
      const duplicateEmailError = peoplePatchDuplicateEmailError(error, query, nextPatch);
      if (duplicateEmailError) throw duplicateEmailError;
      const column = missingOptionalPeopleColumn(error);
      if (!column || store.omittedPeopleColumns?.has(column)) throw error;
      store.omittedPeopleColumns.add(column);
      nextPatch = peopleRowWithKnownColumns(store, patch);
      if (!Object.keys(nextPatch).length) return;
      console.warn("supabase_storage:people_optional_column_omitted", {
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
      const existing = await this.select("people", `select=id,email&email=ilike.${encodeFilter(email)}&limit=1`);
      const existingId = existing[0]?.id || "";
      if (existingId) {
        await upsertPersonAccepting(this, { ...row, id: existingId, email });
        return;
      }
    }
    await upsertPersonAccepting(this, { ...row, email: email || row.email });
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
    // Supabase REST gives us no transaction, so transaction control is a no-op
    // here exactly as begin/commit/rollback are above. Callers still use
    // savepoints to isolate a single failing row when running against real
    // Postgres; over REST the caller's try/catch does that work instead.
    if (
      sql.startsWith("savepoint ") ||
      sql.startsWith("release savepoint ") ||
      sql.startsWith("rollback to savepoint ")
    ) {
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

    if (sql === "select id from calendar_items") {
      const rows = await this.select("calendar_items", "select=id");
      return { rows };
    }
    if (sql === "select id, account_id from calendar_items") {
      const rows = await selectCalendarItemsWithAccountFallback(
        this,
        "select=id,account_id",
        "select=id",
        "select_id_account_id",
      );
      return { rows };
    }
    if (sql === "select id from calendar_items where account_id = $1") {
      const rows = await selectCalendarItemsWithAccountFallback(
        this,
        `select=id&account_id=eq.${encodeFilter(values[0])}`,
        "select=id",
        "select_id_by_account",
      );
      return { rows };
    }
    if (sql === "select id from calendar_items where id = $1 limit 1") {
      const rows = await this.select(
        "calendar_items",
        `select=id&id=eq.${encodeFilter(values[0])}&limit=1`,
      );
      return { rows };
    }
    if (sql === "select id from calendar_items where account_id = $1 and id = $2 limit 1") {
      const rows = await selectCalendarItemsWithAccountFallback(
        this,
        `select=id&account_id=eq.${encodeFilter(values[0])}&id=eq.${encodeFilter(values[1])}&limit=1`,
        `select=id&id=eq.${encodeFilter(values[1])}&limit=1`,
        "select_id_by_account_and_id",
      );
      return { rows };
    }
    if (sql.startsWith("select * from calendar_items")) {
      return this.select(
        "calendar_items",
        "select=*&order=week.asc,day.asc,start.asc,id.asc",
      );
    }
    if (sql === "delete from calendar_items where account_id = $1") {
      await deleteCalendarItemsWithAccountFallback(
        this,
        `account_id=eq.${encodeFilter(values[0])}`,
        "id=not.is.null",
        "delete_by_account",
      );
      return { rows: [] };
    }
    if (sql === "delete from calendar_items where account_id = $1 and not (id = any($2::text[]))") {
      await deleteCalendarItemsExceptIds(this, values[1], values[0]);
      return { rows: [] };
    }
    if (sql === "delete from calendar_items where not (id = any($1::text[]))") {
      await deleteCalendarItemsExceptIds(this, values[0]);
      return { rows: [] };
    }
    if (sql === "delete from calendar_items") {
      await this.delete("calendar_items", "id=not.is.null");
      return { rows: [] };
    }
    if (sql === "delete from calendar_items where id = $1") {
      await this.delete("calendar_items", `id=eq.${encodeFilter(values[0])}`);
      return { rows: [] };
    }
    if (sql === "delete from calendar_items where account_id = $1 and id = $2") {
      await deleteCalendarItemsWithAccountFallback(
        this,
        `account_id=eq.${encodeFilter(values[0])}&id=eq.${encodeFilter(values[1])}`,
        `id=eq.${encodeFilter(values[1])}`,
        "delete_by_account_and_id",
      );
      return { rows: [] };
    }
    if (sql.includes("insert into calendar_items")) {
      await upsertCalendarItemsAccepting(this, [calendarItemFromParams(values, sql)]);
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
        `select=id&email=ilike.${encodeFilter(String(values[0] || "").toLowerCase())}&limit=1`,
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
    if (sql === "update people set account_id = $1 where account_id is null or btrim(account_id) = ''") {
      const patch = { account_id: values[0] };
      await updatePeopleAccepting(this, "account_id=is.null", patch);
      await updatePeopleAccepting(this, `account_id=eq.${encodeFilter("")}`, patch);
      return { rows: [] };
    }
	    if (sql.startsWith("update people")) {
	      await updatePeopleAccepting(
          this,
	        `id=eq.${encodeFilter(values[0])}`,
	        personPatchFromParams(values, sql),
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
    if (
      sql.startsWith(
        "select id, password_hash, password_salt from admin_users where email = $1",
      )
    ) {
      return this.select(
        "admin_users",
        `select=id,password_hash,password_salt&email=eq.${encodeFilter(values[0])}`,
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
    if (sql.startsWith("select id from admin_sessions where token_hash")) {
      return this.select(
        "admin_sessions",
        `select=id&token_hash=eq.${encodeFilter(values[0])}&expires_at=gt.${encodeFilter(values[1] || nowIso())}&limit=1`,
      );
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

function calendarItemFromParams(values, sqlText = "") {
  const columns = calendarItemInsertColumns(sqlText);
  if (columns.length) {
    const row = {};
    columns.forEach((column, index) => {
      if (column === "created_at" || column === "updated_at") return;
      const value = values[index];
      row[column] = CALENDAR_ITEM_JSON_COLUMNS.has(column)
        ? parseJsonParam(value, column)
        : value;
    });
    return cleanRow({
      ...row,
      status: row.status || "booked",
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  }

  const [id, kind, week, day, start, duration, service_id, client, title, phone, email, note, status, custom_group] = values;
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
    custom_group: parseJsonParam(custom_group, "custom_group"),
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
    account_id,
	  ] = values;
	  return cleanRow({
	    id,
    account_id: account_id || null,
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

function personPatchFromParams(values, sqlText = "") {
  const [
    ,
    name,
    email,
    phone,
    notes,
	    source,
	    caddy_profile_id,
	    caddy_profile_url,
    account_id,
	  ] = values;
  const writesEmail = !sqlText || /\bemail\s*=/.test(normalizeSql(sqlText));
	  return {
	    name,
    ...(account_id !== undefined ? { account_id: account_id || null } : {}),
    ...(writesEmail ? { email: email || null } : {}),
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
