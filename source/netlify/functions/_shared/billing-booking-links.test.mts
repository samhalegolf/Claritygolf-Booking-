/**
 * Voiding an invoice releases its lessons.
 *
 * The booking/invoice link table has a unique index on (account_id, booking_id):
 * one lesson, one invoice, enforced by the database. That is the right rule
 * while an invoice stands, and the wrong one the moment it is withdrawn - a
 * voided invoice bills nobody, so its lessons must be billable again.
 *
 * Before this, they weren't. Revising a published invoice (void the old one,
 * re-issue under a new number) was refused on every lesson carried over,
 * because the links still pointed at the invoice being replaced. The coach was
 * stuck: the only way out of the blocker was the thing the blocker prevented.
 *
 * Both halves are pinned here - the lookup that draws the "already invoiced"
 * marker, and the write that refuses the save.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { checkBookingLinks, createBookingLinks } from "../billing-api.mts";

type Row = Record<string, unknown>;

type Fixture = {
  // booking_id -> invoice_id
  links: Map<string, string>;
  // invoice_id -> status
  invoices: Map<string, { invoice_number: string; status: string }>;
};

/**
 * Enough PostgREST to answer the three calls these functions make: read the
 * links for a set of bookings, read the invoices they point at, and
 * insert/delete links. The unique index is modelled too - an insert onto a
 * booking that already has a link 409s, exactly as Postgres would.
 */
function stubSupabase(fixture: Fixture, options: { failLinkReads?: boolean } = {}) {
  const deletes: string[] = [];
  const original = globalThis.fetch;
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-key";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const table = url.pathname.split("/rest/v1/")[1] || "";
    const method = (init?.method || "GET").toUpperCase();
    const query = decodeURIComponent(url.search);
    const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

    const inList = (field: string) => {
      const match = new RegExp(`${field}=in\\.\\(([^)]*)\\)`).exec(query);
      if (!match) return null;
      return match[1].split(",").map((value) => value.trim().replace(/^"|"$/g, "")).filter(Boolean);
    };

    if (table === "billing_booking_invoice_links" && method === "GET") {
      if (options.failLinkReads) return new Response('{"message":"boom"}', { status: 500 });
      const wanted = inList("booking_id") || [];
      const rows: Row[] = [];
      for (const bookingId of wanted) {
        const invoiceId = fixture.links.get(bookingId);
        if (invoiceId) rows.push({ booking_id: bookingId, invoice_id: invoiceId });
      }
      return ok(rows);
    }

    if (table === "billing_invoices" && method === "GET") {
      const wanted = inList("id") || [];
      return ok(
        wanted
          .filter((id) => fixture.invoices.has(id))
          .map((id) => ({ id, ...fixture.invoices.get(id) })),
      );
    }

    if (table === "billing_booking_invoice_links" && method === "DELETE") {
      deletes.push(query);
      const bookings = inList("booking_id") || [];
      const invoices = inList("invoice_id");
      for (const bookingId of bookings) {
        const held = fixture.links.get(bookingId);
        if (held && (!invoices || invoices.includes(held))) fixture.links.delete(bookingId);
      }
      return new Response(null, { status: 204 });
    }

    if (table === "billing_booking_invoice_links" && method === "POST") {
      const rows = JSON.parse(String(init?.body || "[]")) as Row[];
      // The unique index: all-or-nothing, like the single statement it is.
      const clash = rows.find((row) => fixture.links.has(String(row.booking_id)));
      if (clash) return new Response('{"code":"23505"}', { status: 409 });
      for (const row of rows) fixture.links.set(String(row.booking_id), String(row.invoice_id));
      return new Response(null, { status: 201 });
    }

    throw new Error(`unstubbed ${method} ${table}${query}`);
  }) as typeof fetch;

  return { deletes, restore: () => { globalThis.fetch = original; } };
}

function fixture(
  links: Array<[booking: string, invoice: string]>,
  invoices: Array<[id: string, number: string, status: string]>,
): Fixture {
  return {
    links: new Map(links),
    invoices: new Map(invoices.map(([id, invoice_number, status]) => [id, { invoice_number, status }])),
  };
}

test("a lesson on a voided invoice is not reported as invoiced", async () => {
  const data = fixture(
    [["booking-1", "inv-void"], ["booking-2", "inv-live"]],
    [["inv-void", "SHG-0100", "void"], ["inv-live", "SHG-0101", "sent"]],
  );
  const stub = stubSupabase(data);
  try {
    const { links } = await checkBookingLinks("acct-1", ["booking-1", "booking-2"]);
    assert.deepEqual(Object.keys(links), ["booking-2"], "the voided invoice's lesson is free again");
    assert.equal(links["booking-2"].invoiceNumber, "SHG-0101");
  } finally {
    stub.restore();
  }
});

test("an invoice we cannot resolve still blocks - a failed lookup must not un-invoice a lesson", async () => {
  const data = fixture([["booking-1", "inv-missing"]], []);
  const stub = stubSupabase(data);
  try {
    const { links } = await checkBookingLinks("acct-1", ["booking-1"]);
    assert.deepEqual(Object.keys(links), ["booking-1"]);
  } finally {
    stub.restore();
  }
});

test("a lesson held by a voided invoice can be re-invoiced", async () => {
  const data = fixture([["booking-1", "inv-void"]], [["inv-void", "SHG-0100", "void"]]);
  const stub = stubSupabase(data);
  try {
    await createBookingLinks("acct-1", "inv-new", ["booking-1"], { rollbackInvoiceOnConflict: false });
    assert.equal(data.links.get("booking-1"), "inv-new", "the stale link was cleared and re-claimed");
    assert.equal(stub.deletes.length, 1, "only the stale link is deleted");
    assert.match(stub.deletes[0], /account_id=eq\.acct-1/, "the cleanup stays inside the account");
  } finally {
    stub.restore();
  }
});

test("a lesson held by a live invoice still blocks, and the refusal names it", async () => {
  const data = fixture([["booking-1", "inv-live"]], [["inv-live", "SHG-0101", "sent"]]);
  const stub = stubSupabase(data);
  try {
    await assert.rejects(
      createBookingLinks("acct-1", "inv-new", ["booking-1"], { rollbackInvoiceOnConflict: false }),
      (error: Error & { code?: string; status?: number; details?: { conflicts?: unknown[] } }) => {
        assert.equal(error.code, "BOOKING_ALREADY_INVOICED");
        assert.equal(error.status, 409);
        assert.match(error.message, /SHG-0101/, "the coach is told which invoice to void");
        // The warning beside the buttons is built from this: without it the
        // coach is told "already invoiced" and left to find out which lesson.
        assert.deepEqual(error.details?.conflicts, [
          { bookingId: "booking-1", invoiceId: "inv-live", invoiceNumber: "SHG-0101" },
        ]);
        return true;
      },
    );
    assert.equal(data.links.get("booking-1"), "inv-live", "the live claim is untouched");
    assert.equal(stub.deletes.length, 0, "nothing is cleared on a real conflict");
  } finally {
    stub.restore();
  }
});

test("a revision takes its lessons from the invoice it replaces, voided or not", async () => {
  // The failure this exists for: revise a published invoice, and every lesson
  // carried over is refused because the invoice being replaced still holds it.
  // The refusal named the very invoice the coach was replacing, which reads as
  // the system arguing with itself. Note the source is still "sent" here - the
  // point is that this no longer depends on a void landing first.
  const data = fixture(
    [["booking-1", "inv-old"], ["booking-2", "inv-old"]],
    [["inv-old", "SHG-0414", "sent"]],
  );
  const stub = stubSupabase(data);
  try {
    await createBookingLinks("acct-1", "inv-new", ["booking-1", "booking-2"], {
      replacesInvoiceId: "inv-old",
    });
    assert.equal(data.links.get("booking-1"), "inv-new");
    assert.equal(data.links.get("booking-2"), "inv-new");
  } finally {
    stub.restore();
  }
});

test("replacing one invoice does not take lessons from a different one", async () => {
  const data = fixture(
    [["booking-1", "inv-old"], ["booking-2", "inv-other"]],
    [["inv-old", "SHG-0414", "sent"], ["inv-other", "SHG-0415", "sent"]],
  );
  const stub = stubSupabase(data);
  try {
    await assert.rejects(
      createBookingLinks("acct-1", "inv-new", ["booking-1", "booking-2"], {
        rollbackInvoiceOnConflict: false,
        replacesInvoiceId: "inv-old",
      }),
      (error: Error & { details?: { conflicts?: Array<{ invoiceNumber?: string }> } }) => {
        // Only the unrelated invoice is named - the one being replaced was
        // never in the coach's way.
        assert.deepEqual(error.details?.conflicts?.map((c) => c.invoiceNumber), ["SHG-0415"]);
        return true;
      },
    );
    assert.equal(data.links.get("booking-1"), "inv-old", "a refused save moves nothing");
    assert.equal(stub.deletes.length, 0);
  } finally {
    stub.restore();
  }
});

test("force moves a lesson off a live invoice - and only when asked", async () => {
  const data = fixture([["booking-1", "inv-live"]], [["inv-live", "SHG-0101", "sent"]]);
  const stub = stubSupabase(data);
  try {
    await createBookingLinks("acct-1", "inv-new", ["booking-1"], {
      rollbackInvoiceOnConflict: false,
      force: true,
    });
    assert.equal(data.links.get("booking-1"), "inv-new", "publish anyway carries the lesson across");
    assert.match(stub.deletes[0], /account_id=eq\.acct-1/, "the release stays inside the account");
  } finally {
    stub.restore();
  }
});

test("force does not reach past the bookings being saved", async () => {
  const data = fixture(
    [["booking-1", "inv-live"], ["booking-other", "inv-live"]],
    [["inv-live", "SHG-0101", "sent"]],
  );
  const stub = stubSupabase(data);
  try {
    await createBookingLinks("acct-1", "inv-new", ["booking-1"], {
      rollbackInvoiceOnConflict: false,
      force: true,
    });
    assert.equal(
      data.links.get("booking-other"),
      "inv-live",
      "a lesson that is not on this invoice keeps its claim, same invoice or not",
    );
  } finally {
    stub.restore();
  }
});

test("a lookup that fails refuses the save rather than clearing links blindly", async () => {
  const data = fixture([["booking-1", "inv-live"]], [["inv-live", "SHG-0101", "sent"]]);
  const stub = stubSupabase(data, { failLinkReads: true });
  try {
    await assert.rejects(
      createBookingLinks("acct-1", "inv-new", ["booking-1"], { rollbackInvoiceOnConflict: false, force: true }),
      (error: Error & { code?: string }) => error.code === "BOOKING_ALREADY_INVOICED",
    );
    assert.equal(data.links.get("booking-1"), "inv-live");
    assert.equal(stub.deletes.length, 0, "nothing is released on a guess");
  } finally {
    stub.restore();
  }
});

test("one live claim in a batch blocks the whole save, voided ones included", async () => {
  const data = fixture(
    [["booking-1", "inv-void"], ["booking-2", "inv-live"]],
    [["inv-void", "SHG-0100", "void"], ["inv-live", "SHG-0101", "sent"]],
  );
  const stub = stubSupabase(data);
  try {
    await assert.rejects(
      createBookingLinks("acct-1", "inv-new", ["booking-1", "booking-2"], { rollbackInvoiceOnConflict: false }),
      (error: Error & { code?: string }) => error.code === "BOOKING_ALREADY_INVOICED",
    );
    assert.equal(data.links.get("booking-1"), "inv-void", "a refused save leaves every link as it found it");
    assert.equal(stub.deletes.length, 0);
  } finally {
    stub.restore();
  }
});
