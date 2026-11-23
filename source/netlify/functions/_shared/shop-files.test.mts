/**
 * A digital product's files.
 *
 * These are the thing being sold, so what is worth pinning down is that a
 * product can only ever hand over its own business's files, of a kind that
 * may be sold, and that nothing is saved selling a file that is not there.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MAX_SHOP_FILE_BYTES, cleanShopFiles, shopFileFormat } from "./shop-file-rules.mts";
import {
  signedShopFileUrl,
  startShopFileUpload,
  sweepUnusedShopFiles,
  verifyShopFiles,
} from "./shop-files.mts";

process.env.SUPABASE_URL = "https://project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";

const pdf = { path: "acct-1/abc-Clarity-Method.pdf", name: "Clarity Method.pdf", bytes: 2_000_000 };
const epub = { path: "acct-1/def-Clarity-Method.epub", name: "Clarity Method.epub", bytes: 900_000 };

type Call = { url: string; method: string; body: string };
function storage(answers: Array<{ status?: number; json?: unknown; text?: string }>) {
  const calls: Call[] = [];
  const doFetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method || "GET", body: typeof init?.body === "string" ? init.body : "" });
    const answer = answers.shift() || { json: {} };
    return new Response(answer.text ?? JSON.stringify(answer.json ?? {}), { status: answer.status || 200 });
  };
  return { calls, doFetch };
}

test("a product keeps its own business's files, one per format", () => {
  assert.deepEqual(cleanShopFiles([pdf, epub], "acct-1"), [pdf, epub]);
  assert.deepEqual(cleanShopFiles(JSON.stringify([pdf]), "acct-1"), [pdf]);
  // A second PDF would be a file no link could name.
  assert.deepEqual(cleanShopFiles([pdf, { ...pdf, path: "acct-1/zzz-Other.pdf" }], "acct-1"), [pdf]);
});

test("a file in another business's folder, or outside the folder, is dropped", () => {
  assert.deepEqual(cleanShopFiles([pdf], "acct-2"), []);
  assert.deepEqual(cleanShopFiles([{ ...pdf, path: "acct-1/../acct-2/x.pdf" }], "acct-1"), []);
  assert.deepEqual(cleanShopFiles([{ ...pdf, path: "acct-1/sub/x.pdf" }], "acct-1"), []);
  assert.deepEqual(cleanShopFiles([pdf], ""), []);
});

test("a kind of file that can't be sold, or a name that disagrees with its path, is dropped", () => {
  assert.deepEqual(cleanShopFiles([{ path: "acct-1/abc-page.html", name: "page.html", bytes: 10 }], "acct-1"), []);
  assert.deepEqual(cleanShopFiles([{ ...pdf, name: "Clarity Method.epub" }], "acct-1"), []);
  assert.deepEqual(cleanShopFiles([{ ...pdf, bytes: 0 }], "acct-1"), []);
});

test("the format a buyer reads is the extension", () => {
  assert.equal(shopFileFormat("Clarity Method.pdf"), "PDF");
  assert.equal(shopFileFormat("book.final.EPUB"), "EPUB");
  assert.equal(shopFileFormat("no-extension"), "");
});

test("an upload gets a place in the business's folder and a signed address to send the bytes to", async () => {
  const { calls, doFetch } = storage([{ json: { url: "/object/upload/sign/shop-downloads/acct-1/x.pdf?token=abc" } }]);
  const upload = await startShopFileUpload("acct-1", { name: "The Clarity Method: 2nd/Edition.pdf", bytes: 5_000_000 }, doFetch);
  assert.match(upload.path, /^acct-1\/[a-z0-9]{16}-The-Clarity-Method-2nd-Edition\.pdf$/);
  assert.equal(upload.name, "The Clarity Method 2nd Edition.pdf");
  assert.equal(upload.type, "application/pdf");
  assert.equal(upload.uploadUrl, "https://project.supabase.co/storage/v1/object/upload/sign/shop-downloads/acct-1/x.pdf?token=abc");
  assert.equal(calls[0].method, "POST");
  // What comes back is what a product may be saved with.
  assert.equal(cleanShopFiles([upload], "acct-1").length, 1);
});

test("a name with no plain letters keeps its extension", async () => {
  const { doFetch } = storage([{ json: { url: "/signed" } }]);
  const upload = await startShopFileUpload("acct-1", { name: "ゴルフの本.epub", bytes: 1000 }, doFetch);
  assert.equal(upload.name, "download.epub");
});

test("an upload is refused for a kind that can't be sold, an empty file or one too large", async () => {
  const { calls, doFetch } = storage([]);
  await assert.rejects(startShopFileUpload("acct-1", { name: "run-me.exe", bytes: 10 }, doFetch), /can't be sold/);
  await assert.rejects(startShopFileUpload("acct-1", { name: "page.html", bytes: 10 }, doFetch), /can't be sold/);
  await assert.rejects(startShopFileUpload("acct-1", { name: "book.pdf", bytes: 0 }, doFetch), /empty/);
  await assert.rejects(startShopFileUpload("acct-1", { name: "book.pdf", bytes: MAX_SHOP_FILE_BYTES + 1 }, doFetch), /too large/);
  assert.equal(calls.length, 0);
});

test("the first upload makes the bucket when the migration could not", async () => {
  const { calls, doFetch } = storage([
    { status: 400, text: '{"message":"Bucket not found"}' },
    { json: {} },
    { json: { url: "/object/upload/sign/shop-downloads/acct-1/x.pdf?token=abc" } },
  ]);
  await startShopFileUpload("acct-1", { name: "book.pdf", bytes: 10 }, doFetch);
  assert.equal(calls[1].url, "https://project.supabase.co/storage/v1/bucket");
  assert.equal(JSON.parse(calls[1].body).public, false);
});

test("a save takes a new file's size from storage, and refuses one that never arrived", async () => {
  const arrived = storage([{ json: { size: 2_345_678 } }]);
  assert.deepEqual(await verifyShopFiles([{ ...pdf, bytes: 1 }], [], arrived.doFetch), [{ ...pdf, bytes: 2_345_678 }]);

  const missing = storage([{ status: 404, text: "not found" }]);
  await assert.rejects(verifyShopFiles([pdf], [], missing.doFetch), /did not finish uploading/);

  // A file already on the product was checked when it was saved.
  const known = storage([]);
  assert.deepEqual(await verifyShopFiles([{ ...pdf, bytes: 1 }], [pdf], known.doFetch), [pdf]);
  assert.equal(known.calls.length, 0);
});

test("a download address is signed, short-lived, and saves under the file's own name", async () => {
  const { calls, doFetch } = storage([{ json: { signedURL: "/object/sign/shop-downloads/acct-1/abc-Clarity-Method.pdf?token=t" } }]);
  const url = await signedShopFileUrl(pdf, 60, doFetch);
  assert.equal(url, "https://project.supabase.co/storage/v1/object/sign/shop-downloads/acct-1/abc-Clarity-Method.pdf?token=t&download=Clarity%20Method.pdf");
  assert.deepEqual(JSON.parse(calls[0].body), { expiresIn: 60 });
});

test("the sweep removes old uploads no product hands over, and leaves fresh ones", async () => {
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const { calls, doFetch } = storage([
    {
      json: [
        { name: "abc-Clarity-Method.pdf", created_at: old },
        { name: "old-First-Edition.pdf", created_at: old },
        { name: "new-Still-On-A-Form.pdf", created_at: new Date().toISOString() },
      ],
    },
    { json: [] },
  ]);
  assert.equal(await sweepUnusedShopFiles("acct-1", [pdf.path], doFetch), 1);
  assert.equal(calls[1].method, "DELETE");
  assert.deepEqual(JSON.parse(calls[1].body), { prefixes: ["acct-1/old-First-Edition.pdf"] });
});
