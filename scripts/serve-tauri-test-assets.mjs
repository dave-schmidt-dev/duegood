import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = await realpath(path.join(projectRoot, "dist", "public"));
const argumentIndex = process.argv.indexOf("--port");
const port = argumentIndex < 0 ? 8791 : Number(process.argv[argumentIndex + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be a valid TCP port.");

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidate = path.resolve(assetRoot, relativePath);
  if (candidate !== assetRoot && !candidate.startsWith(`${assetRoot}${path.sep}`)) {
    response.writeHead(404).end();
    return;
  }

  try {
    const resolved = await realpath(candidate);
    if (resolved !== assetRoot && !resolved.startsWith(`${assetRoot}${path.sep}`)) {
      response.writeHead(404).end();
      return;
    }
    const details = await stat(resolved);
    if (!details.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Length": details.size,
      "Content-Type": contentTypes.get(path.extname(resolved)) ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") response.end();
    else response.end(await readFile(resolved));
  } catch {
    response.writeHead(404).end();
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Serving built Tauri UI assets on 127.0.0.1:${port}.\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
