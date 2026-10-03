import assert from "node:assert/strict";
import test from "node:test";

import videoTransferHandler from "../video-transfer.mts";

/* The review page and drill library routes, against a stand-in Supabase.
 * What matters here is what reaches the database: cleaned blocks, and the
 * rule that only a drill's author can change it. */

type Call = { method: string; url: string; body: any };

function withSupabase(rows: Record<string, any[]>) {
  const calls: Call[] = [];
  const originalFetch = globalThis.fetch;
  const env = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = "https://supabase.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const table = url.split("/rest/v1/")[1]?.split("?")[0] || "";
    if (method === "GET") return Response.json(rows[table] || []);
    if (method === "POST" || method === "PATCH") return Response.json([{ ...(rows[table]?.[0] || {}), ...body }]);
    return new Response("", { status: 204 });
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
      if (env.url === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = env.url;
      if (env.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = env.key;
    },
  };
}

const seam = (authUserId = "") => ({
  resolveAccountId: async () => "biz-1",
  resolveAuthUserId: async () => authUserId,
});

const request = (path: string, init: RequestInit = {}) =>
  new Request(`https://claritygolf.app/api/video-transfer/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });

test("saving a review page stores cleaned blocks, never a script link", async () => {
  const db = withSupabase({ swing_review_documents: [] });
  try {
    const response = await videoTransferHandler(
      request("review/doc", {
        method: "PUT",
        body: JSON.stringify({
          lessonId: "swing-review-1757808000000",
          playerId: "person-1",
          title: "Grip",
          blocks: [
            { id: "a", type: "note", title: "Grip", body: "Weaker" },
            { id: "b", type: "link", url: "javascript:alert(1)", label: "x" },
            { id: "c", type: "html", body: "<script>" },
          ],
        }),
      }),
      undefined,
      seam("coach-1"),
    );
    assert.equal(response.status, 200);
    const insert = db.calls.find((call) => call.method === "POST" && call.url.includes("swing_review_documents"));
    assert.ok(insert, "a new page is inserted");
    assert.equal(insert.body.account_id, "biz-1");
    assert.deepEqual(
      insert.body.blocks.map((block: any) => [block.type, block.url ?? ""]),
      [
        ["note", ""],
        ["link", ""],
      ],
    );
  } finally {
    db.restore();
  }
});

test("a review page refuses anything that is not a swing review", async () => {
  const db = withSupabase({});
  try {
    const response = await videoTransferHandler(
      request("review/doc", { method: "PUT", body: JSON.stringify({ lessonId: "lesson-1", playerId: "p" }) }),
      undefined,
      seam("coach-1"),
    );
    assert.equal(response.status, 400);
    assert.equal(db.calls.length, 0);
  } finally {
    db.restore();
  }
});

test("a sent review cannot be discarded", async () => {
  const db = withSupabase({
    swing_review_documents: [
      { lesson_id: "swing-review-1", player_id: "p", blocks: [], sent_at: "2026-10-01T00:00:00Z" },
    ],
  });
  try {
    const response = await videoTransferHandler(
      request("review/doc?lessonId=swing-review-1", { method: "DELETE" }),
      undefined,
      seam("coach-1"),
    );
    assert.equal(response.status, 409);
    assert.ok(!db.calls.some((call) => call.method === "DELETE"));
  } finally {
    db.restore();
  }
});

test("every coach reads the drill library; `mine` marks the caller's own", async () => {
  const db = withSupabase({
    coach_drills: [
      { id: "d1", title: "Gate", created_by: "coach-1", youtube_id: "dQw4w9WgXcQ" },
      { id: "d2", title: "Step", created_by: "coach-2" },
    ],
  });
  try {
    const response = await videoTransferHandler(request("drills"), undefined, seam("coach-1"));
    const body = (await response.json()) as any;
    assert.equal(response.status, 200);
    assert.deepEqual(
      body.drills.map((drill: any) => [drill.id, drill.mine]),
      [
        ["d1", true],
        ["d2", false],
      ],
    );
  } finally {
    db.restore();
  }
});

test("only the coach who made a drill can change or delete it", async () => {
  const db = withSupabase({ coach_drills: [{ id: "d2", title: "Step", created_by: "coach-2" }] });
  try {
    const edit = await videoTransferHandler(
      request("drills/d2", { method: "PUT", body: JSON.stringify({ title: "Mine now" }) }),
      undefined,
      seam("coach-1"),
    );
    assert.equal(edit.status, 403);
    const remove = await videoTransferHandler(request("drills/d2", { method: "DELETE" }), undefined, seam("coach-1"));
    assert.equal(remove.status, 403);
    assert.ok(!db.calls.some((call) => call.method === "PATCH" || call.method === "DELETE"));

    const own = await videoTransferHandler(
      request("drills/d2", { method: "PUT", body: JSON.stringify({ title: "Step, feet together" }) }),
      undefined,
      seam("coach-2"),
    );
    assert.equal(own.status, 200);
  } finally {
    db.restore();
  }
});

test("a new drill is stamped with its author", async () => {
  const db = withSupabase({ coach_drills: [] });
  try {
    const response = await videoTransferHandler(
      request("drills", {
        method: "POST",
        body: JSON.stringify({ title: "Gate", youtubeUrl: "https://youtu.be/dQw4w9WgXcQ?t=30", authorName: "Sam" }),
      }),
      undefined,
      seam("coach-1"),
    );
    assert.equal(response.status, 201);
    const insert = db.calls.find((call) => call.method === "POST");
    assert.equal(insert?.body.created_by, "coach-1");
    assert.equal(insert?.body.youtube_id, "dQw4w9WgXcQ");
  } finally {
    db.restore();
  }
});
