import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { config, brainLabel, voiceLabel, configProblems } from "./config.ts";
import { Session } from "./session.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const webDist = join(here, "..", "web", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// In production (`npm run build && npm start`) the server also serves the
// built web client. In dev, Vite serves the client and proxies /ws here.
const server = createServer(async (req, res) => {
  const path = normalize(req.url?.split("?")[0] ?? "/").replace(/^(\.\.[/\\])+/, "");
  const file = path === "/" ? "index.html" : path.slice(1);
  try {
    const body = await readFile(join(webDist, file));
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found. In dev, use the Vite URL instead.");
  }
});

const wss = new WebSocketServer({ server, path: "/ws" });

// Heartbeat: ping every 30 s, drop connections that never pong, so dead
// sessions release their STT streams instead of leaking.
const alive = new WeakMap<import("ws").WebSocket, boolean>();
wss.on("connection", (ws) => {
  alive.set(ws, true);
  ws.on("pong", () => alive.set(ws, true));
  new Session(ws);
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (alive.get(ws) === false) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, 30000).unref();

server.listen(config.port, () => {
  console.log(`ThirdChair server on http://localhost:${config.port}`);
  console.log(`  wake phrase: "${config.wakePhrase}"`);
  console.log(`  brain: ${brainLabel()}`);
  console.log(`  voice: ${voiceLabel()}`);
  for (const problem of configProblems()) console.warn(`  ⚠ ${problem}`);
});
