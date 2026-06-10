import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { calendarApiMiddleware } from "./calendar-api.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const distDir = join(root, "dist");
const port = Number(process.env.PORT || 4173);
const calendarApi = calendarApiMiddleware();

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
]);

function runApi(req, res) {
  return new Promise((resolve) => {
    let passed = false;
    void calendarApi(req, res, () => {
      passed = true;
      resolve(false);
    }).then(() => {
      if (!passed) resolve(true);
    });
  });
}

function sendStatus(res, status, message) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(message);
}

async function serveFile(res, filePath) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) return false;
  res.statusCode = 200;
  res.setHeader("Content-Type", mimeTypes.get(extname(filePath)) || "application/octet-stream");
  res.setHeader("Cache-Control", filePath.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
  createReadStream(filePath).pipe(res);
  return true;
}

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", "http://clarity.local");
  const decodedPath = decodeURIComponent(url.pathname);
  const requestedPath = normalize(decodedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(distDir, requestedPath === "/" ? "index.html" : requestedPath);

  try {
    if (await serveFile(res, filePath)) return;
  } catch {
    // Fall back to the SPA shell below.
  }

  try {
    await serveFile(res, join(distDir, "index.html"));
  } catch {
    sendStatus(res, 404, "Build output not found. Run npm run build first.");
  }
}

const server = createServer(async (req, res) => {
  if (await runApi(req, res)) return;
  await serveStatic(req, res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Clarity Golf Booking System running at http://127.0.0.1:${port}`);
});
