import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHttpServer } from "../mcp-server/server.js";
import { loadDatabase } from "../shared/db.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverFile = path.join(root, "mcp-server", "server.ts");

/** Spawn the real server over stdio and talk JSON-RPC to it. */
async function stdioSession(messages: object[]): Promise<any[]> {
  const p = spawn(process.execPath, ["--import", "tsx", serverFile], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  for (const m of messages) p.stdin.write(JSON.stringify(m) + "\n");
  p.stdin.end();
  const [code] = await once(p, "close");
  assert.equal(code, 0);
  return out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };
const call = (id: number, name: string, args: object) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

test("stdio: handshake, tools/list, tool calls, errors", async () => {
  const res = await stdioSession([
    init,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    call(3, "search_minecraft", { query: "سيف ألماس" }),
    call(4, "get_recipe", { item: "Torch" }),
    call(5, "get_entry", { id: "nothing-like-this-xyz" }),
    call(6, "search_minecraft", {}),
    { jsonrpc: "2.0", id: 7, method: "does/not/exist" },
    { jsonrpc: "2.0", id: 8, method: "ping" },
  ]);
  const byId = new Map(res.map((r) => [r.id, r]));
  assert.equal(res.length, 8, "8 requests + 1 notification => exactly 8 responses");
  assert.equal(byId.get(1).result.protocolVersion, "2025-06-18");
  assert.equal(byId.get(1).result.serverInfo.name, "hero-minecraft-database");
  const names = byId.get(2).result.tools.map((t: any) => t.name);
  for (const n of ["search_minecraft", "get_entry", "get_recipe", "get_image", "list_entries", "database_stats"]) assert.ok(names.includes(n), n);
  assert.equal(JSON.parse(byId.get(3).result.content[0].text).results[0].id, "minecraft:diamond_sword");
  assert.equal(JSON.parse(byId.get(4).result.content[0].text).producedBy[0].result.count, 4);
  assert.equal(byId.get(5).result.isError, true);
  assert.equal(byId.get(6).result.isError, true);
  assert.equal(byId.get(7).error.code, -32601);
  assert.deepEqual(byId.get(8).result, {});
});

test("stdio: malformed JSON gives a parse error and the server keeps running", async () => {
  const p = spawn(process.execPath, ["--import", "tsx", serverFile], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stdin.write("{not json\n" + JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n");
  p.stdin.end();
  await once(p, "close");
  const lines = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines[0].error.code, -32700);
  assert.deepEqual(lines[1].result, {});
});

const servers: ReturnType<typeof createHttpServer>[] = [];
after(() => servers.forEach((s) => s.close()));

async function startHttp(env: NodeJS.ProcessEnv) {
  const s = createHttpServer(loadDatabase(), env);
  servers.push(s);
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  return `http://127.0.0.1:${(s.address() as any).port}`;
}

test("http: /health, POST /mcp, 202 for notifications, auth and origin checks", async () => {
  const base = await startHttp({ MCP_AUTH_TOKEN: "secret" });
  assert.equal((await fetch(base + "/health")).status, 200);

  const headers = { "Content-Type": "application/json", Authorization: "Bearer secret" };
  assert.equal((await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await fetch(base + "/mcp", { method: "POST", headers: { ...headers, Origin: "https://evil.example" }, body: "{}" })).status, 403);

  const r = await fetch(base + "/mcp", { method: "POST", headers, body: JSON.stringify(call(1, "search_minecraft", { query: "zombie" })) });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(((await r.json()) as any).result.content[0].text).results[0].id, "minecraft:zombie");

  const n = await fetch(base + "/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(n.status, 202);
  assert.equal((await fetch(base + "/mcp", { headers })).status, 405);
  assert.equal((await fetch(base + "/mcp", { method: "POST", headers, body: "{oops" })).status, 400);
});
