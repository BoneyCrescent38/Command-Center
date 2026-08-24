import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";
import { createDashboardClient } from "./dashboard-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public");
const packageInfo = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const assetFiles = [
  "index.html",
  "styles.css",
  "app.js",
  "app-registry.js",
  "modules/dashboard.js",
  "modules/placeholder.js",
].map((name) => path.join(publicRoot, name));

export const buildId = createHash("sha256")
  .update(packageInfo.version)
  .update(assetFiles.map((file) => readFileSync(file)).join(""))
  .digest("hex")
  .slice(0, 12);

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
]);

const json = (response, status, body, headers = {}) => {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    ...headers,
  });
  response.end(JSON.stringify(body));
};

const safeHeaders = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-src 'self'; frame-ancestors 'self'",
};

const isSameOriginMutation = (request) => {
  const expected = "http://" + request.headers.host;
  const origin = request.headers.origin;
  const fetchSite = request.headers["sec-fetch-site"];
  return (!origin || origin === expected) && (!fetchSite || fetchSite === "same-origin" || fetchSite === "none");
};

const readJsonBody = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw Object.assign(new Error("Request body too large"), { status: 413, code: "body_too_large" });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400, code: "invalid_json" });
  }
};

const relayCookie = (setCookie) => (setCookie ? { "Set-Cookie": setCookie } : {});

const serveStatic = (pathname, response) => {
  const relative = pathname === "/" ? "index.html" : pathname === "/preview" ? "preview.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(publicRoot, relative);
  if (resolved !== publicRoot && !resolved.startsWith(publicRoot + path.sep)) return false;

  try {
    if (!statSync(resolved).isFile()) return false;
  } catch {
    return false;
  }

  const extension = path.extname(resolved).toLowerCase();
  response.writeHead(200, {
    ...safeHeaders,
    "Content-Type": mimeTypes.get(extension) || "application/octet-stream",
    "Cache-Control": extension === ".html" ? "no-cache, max-age=0" : "public, max-age=300, must-revalidate",
    ETag: '"' + buildId + '"',
  });
  createReadStream(resolved).pipe(response);
  return true;
};

export function createCommandCenterServer(overrides = {}) {
  const config = loadConfig(overrides);
  const dashboard = createDashboardClient(config, overrides.fetchImpl || globalThis.fetch);

  return createServer(async (request, response) => {
    Object.entries(safeHeaders).forEach(([key, value]) => response.setHeader(key, value));
    const url = new URL(request.url || "/", "http://" + (request.headers.host || "127.0.0.1"));

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, {
          status: "ok",
          version: packageInfo.version,
          build: buildId,
          service: "command-center",
        });
      }

      if (request.method === "GET" && url.pathname === "/version.json") {
        return json(response, 200, { version: packageInfo.version, build: buildId });
      }

      if (request.method === "GET" && url.pathname === "/api/dashboard/session") {
        return json(response, 200, await dashboard.session(request.headers.cookie));
      }

      if (request.method === "POST" && url.pathname === "/api/dashboard/login") {
        if (!isSameOriginMutation(request)) return json(response, 403, { code: "origin_rejected", message: "Forespørselen ble avvist" });
        const body = await readJsonBody(request);
        const result = await dashboard.login(body.pin);
        return json(response, 200, { authenticated: result.authenticated }, relayCookie(result.setCookie));
      }

      if (request.method === "POST" && url.pathname === "/api/dashboard/logout") {
        if (!isSameOriginMutation(request)) return json(response, 403, { code: "origin_rejected", message: "Forespørselen ble avvist" });
        const result = await dashboard.logout(request.headers.cookie);
        return json(response, 200, { authenticated: false }, relayCookie(result.setCookie));
      }

      if (request.method === "GET" && url.pathname === "/api/dashboard/data") {
        return json(response, 200, await dashboard.dashboard(request.headers.cookie));
      }

      if (request.method === "GET" && serveStatic(url.pathname, response)) return;
      json(response, 404, { code: "not_found", message: "Ikke funnet" });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (status >= 500) console.error("[command-center]", error?.code || "internal_error");
      json(response, status, {
        code: error?.code || "internal_error",
        message: status >= 500 ? "Tjenesten er midlertidig utilgjengelig" : error?.message || "Forespørselen feilet",
      });
    }
  });
}

const isEntryPoint = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isEntryPoint) {
  const config = loadConfig();
  const server = createCommandCenterServer(config);
  server.listen(config.port, config.host, () => {
    console.log("[command-center] http://" + config.host + ":" + config.port + " build " + buildId);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}