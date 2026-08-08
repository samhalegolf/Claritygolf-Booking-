/**
 * Schema setup is the first thing an instance does, so it is the one place
 * where "one round trip per statement" is paid by every cold start rather than
 * by a save. These pin the two things that make batching it safe: the tag
 * refuses anything that would need a parameter (which would silently break the
 * simple query protocol the batch relies on), and a refused batch degrades to
 * running the statements one at a time rather than failing the boot.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ddlBatch } from "./database.mts";

test("statements collected are sent as one query", async () => {
  const ddl = ddlBatch();
  ddl.sql`CREATE TABLE IF NOT EXISTS a (id TEXT)`;
  ddl.sql`CREATE TABLE IF NOT EXISTS b (id TEXT)`;
  ddl.sql`CREATE INDEX IF NOT EXISTS i ON a (id)`;

  const sent: string[] = [];
  await ddl.run({ query: async (text: string) => void sent.push(text) } as any);

  assert.equal(sent.length, 1, "three statements, one round trip");
  assert.equal(sent[0].split(";").length, 3, "joined, not concatenated");
  assert.ok(sent[0].includes("CREATE TABLE IF NOT EXISTS a"));
  assert.ok(sent[0].includes("CREATE INDEX IF NOT EXISTS i"));
});

test("an empty batch sends nothing", async () => {
  const ddl = ddlBatch();
  let called = false;
  await ddl.run({ query: async () => void (called = true) } as any);
  assert.equal(called, false);
});

test("interpolating a value is refused rather than silently unbatched", () => {
  const ddl = ddlBatch();
  // A parameter would force the extended protocol, which carries one statement
  // per message — the batch would stop being a batch without saying so.
  assert.throws(() => ddl.sql`CREATE TABLE IF NOT EXISTS ${"a"} (id TEXT)`, /cannot take parameters/);
});

test("a refused batch falls back to one statement at a time", async () => {
  const ddl = ddlBatch();
  ddl.sql`CREATE TABLE IF NOT EXISTS a (id TEXT)`;
  ddl.sql`CREATE TABLE IF NOT EXISTS b (id TEXT)`;

  const sent: string[] = [];
  await ddl.run({
    query: async (text: string) => {
      // A pooler that will not take multiple statements refuses the joined one.
      if (text.includes(";")) throw new Error("cannot insert multiple commands");
      sent.push(text);
    },
  } as any);

  assert.deepEqual(sent, [
    "CREATE TABLE IF NOT EXISTS a (id TEXT)",
    "CREATE TABLE IF NOT EXISTS b (id TEXT)",
  ], "boot stays possible, just slower");
});

test("a genuine SQL error still surfaces, pointing at its own statement", async () => {
  const ddl = ddlBatch();
  ddl.sql`CREATE TABLE IF NOT EXISTS a (id TEXT)`;
  ddl.sql`CREATE TABLE IF NOT EXISTS b (bad SYNTAX)`;

  await assert.rejects(
    ddl.run({
      query: async (text: string) => {
        if (text.includes("bad SYNTAX")) throw new Error('type "syntax" does not exist');
      },
    } as any),
    /type "syntax" does not exist/,
  );
});
