import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = process.env.PORT ? Number(process.env.PORT) : 4173;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function safeJoin(base, target) {
  const normalized = normalize(target).replace(/^(\.\.(\/|\\|$))+/, "");
  return join(base, normalized);
}

async function serveFile(pathname, res) {
  const filePath = safeJoin(root, pathname === "/" ? "/index.html" : pathname);

  try {
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      return serveFile("/index.html", res);
    }
    const body = await readFile(filePath);
    const type = mimeTypes[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (
    pathname === "/" ||
    pathname.endsWith(".html") ||
    pathname.endsWith(".js") ||
    pathname.endsWith(".css") ||
    pathname.endsWith(".json") ||
    pathname.endsWith(".svg") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".ico")
  ) {
    const ok = await serveFile(pathname, res);
    if (ok) return;
  }

  const ok = await serveFile("/index.html", res);
  if (!ok) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Draftor running at http://localhost:${port}`);
});
