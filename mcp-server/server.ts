#!/usr/bin/env node
/**
 * HERO Minecraft Database — MCP server.
 *
 * Implements the Model Context Protocol (JSON-RPC 2.0) directly, with zero runtime dependencies:
 *   • stdio transport  (default)  — for Claude Desktop / Claude Code / any local MCP client
 *   • HTTP transport   (--http)   — POST /mcp (Streamable HTTP, JSON responses) + GET /health, for cloud hosting
 *
 * IMPORTANT: in stdio mode stdout carries protocol messages only. All logs go to stderr.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  allEntries,
  entriesOfType,
  getById,
  loadDatabase,
  lookup,
  recipesProducing,
  recipesUsing,
  resolveImage,
  search,
  type Database,
  type Entry,
  type EntryType,
} from "../shared/db.js";

export const SERVER_NAME = "hero-minecraft-database";
export const SERVER_VERSION = "1.0.0";
export const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// ───────────────────────── JSON-RPC types ─────────────────────────

type Id = string | number | null;
interface RpcRequest {
  jsonrpc: "2.0";
  id?: Id;
  method: string;
  params?: any;
}
interface RpcResponse {
  jsonrpc: "2.0";
  id: Id;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const E_PARSE = -32700;
const E_INVALID = -32600;
const E_METHOD = -32601;
const E_PARAMS = -32602;
const E_INTERNAL = -32603;

class RpcError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

// ───────────────────────── Tools ─────────────────────────

const TYPE_ENUM = ["item", "block", "mob"] as const;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (db: Database, args: any) => unknown;
}

function parseType(v: unknown, allowAll = false): EntryType | undefined {
  if (v === undefined || v === null || v === "" || (allowAll && v === "all")) return undefined;
  if (typeof v === "string" && (TYPE_ENUM as readonly string[]).includes(v)) return v as EntryType;
  throw new RpcError(E_PARAMS, `"type" must be one of: ${allowAll ? "all, " : ""}${TYPE_ENUM.join(", ")}`);
}

function requireString(args: any, key: string): string {
  const v = args?.[key];
  if (typeof v !== "string" || v.trim() === "") throw new RpcError(E_PARAMS, `"${key}" is required and must be a non-empty string`);
  return v;
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" ? Math.floor(v) : def;
  return Math.min(max, Math.max(min, n));
}

function describe(db: Database, e: Entry) {
  return {
    type: e.type,
    id: e.id,
    name: e.name,
    aliases: e.aliases ?? {},
    category: e.category,
    image: resolveImage(db, e),
  };
}

const TOOLS: ToolDef[] = [
  {
    name: "search_minecraft",
    description:
      "Search Minecraft Bedrock items, blocks and mobs by name. Accepts Arabic or English (ids, names, aliases; tolerant to diacritics, 'ال' prefixes, plurals and small typos). Returns ranked matches with image URLs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name to look for, e.g. 'Diamond Sword' or 'سيف ألماس'." },
        type: { type: "string", enum: ["all", ...TYPE_ENUM], description: "Restrict to one kind. Default: all." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max results (default 10)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    run: (db, a) => {
      const query = requireString(a, "query");
      const type = parseType(a.type, true);
      const hits = search(db, query, { types: type ? [type] : undefined, limit: clampInt(a.limit, 10, 1, 50) });
      return { query, count: hits.length, results: hits };
    },
  },
  {
    name: "get_entry",
    description:
      "Get full details of one item/block/mob by id (e.g. 'minecraft:creeper' or 'creeper') or by name (Arabic/English), including image URLs and related recipes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Entry id or name." },
        type: { type: "string", enum: [...TYPE_ENUM], description: "Optional: restrict lookup to one kind." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    run: (db, a) => {
      const id = requireString(a, "id");
      const e = lookup(db, id, parseType(a.type));
      if (!e) throw new RpcError(E_PARAMS, `No entry found for "${id}". Try search_minecraft.`);
      return {
        ...describe(db, e),
        craftedBy: recipesProducing(db, e.id),
        usedInRecipes: recipesUsing(db, e.id).map((r) => r.id),
      };
    },
  },
  {
    name: "get_recipe",
    description:
      "Get crafting/smelting recipes that produce an item or block (by id or Arabic/English name), and recipes that use it as an ingredient.",
    inputSchema: {
      type: "object",
      properties: { item: { type: "string", description: "Item/block id or name." } },
      required: ["item"],
      additionalProperties: false,
    },
    run: (db, a) => {
      const q = requireString(a, "item");
      const e = lookup(db, q);
      if (!e || e.type === "mob") throw new RpcError(E_PARAMS, `No item or block found for "${q}".`);
      return {
        target: describe(db, e),
        producedBy: recipesProducing(db, e.id),
        usedIn: recipesUsing(db, e.id),
        note: "Only recipes present in database/recipes.json are listed; the database is a growing subset of the game.",
      };
    },
  },
  {
    name: "get_image",
    description:
      "Get the image reference for an item/block/mob: the official remote texture URL and a local file path if one exists in images/.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Entry id or name." },
        type: { type: "string", enum: [...TYPE_ENUM] },
      },
      required: ["id"],
      additionalProperties: false,
    },
    run: (db, a) => {
      const id = requireString(a, "id");
      const e = lookup(db, id, parseType(a.type));
      if (!e) throw new RpcError(E_PARAMS, `No entry found for "${id}".`);
      return { id: e.id, type: e.type, name: e.name, image: resolveImage(db, e) };
    },
  },
  {
    name: "list_entries",
    description: "List entries of one kind, optionally filtered by category (e.g. hostile, ore, tool). Paginated.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: [...TYPE_ENUM] },
        category: { type: "string", description: "Optional category filter." },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["type"],
      additionalProperties: false,
    },
    run: (db, a) => {
      const type = parseType(a.type);
      if (!type) throw new RpcError(E_PARAMS, '"type" is required');
      const category = typeof a.category === "string" ? a.category.toLowerCase() : undefined;
      const all = entriesOfType(db, type).filter((e) => !category || e.category.toLowerCase() === category);
      const offset = clampInt(a.offset, 0, 0, 1_000_000);
      const limit = clampInt(a.limit, 50, 1, 200);
      return {
        type,
        total: all.length,
        offset,
        results: all.slice(offset, offset + limit).map((e) => ({ id: e.id, name: e.name, category: e.category })),
      };
    },
  },
  {
    name: "database_stats",
    description: "Counts of items, blocks, mobs, recipes and categories in the database.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (db) => {
      const cats = (list: Entry[]) =>
        list.reduce<Record<string, number>>((m, e) => ((m[e.category] = (m[e.category] ?? 0) + 1), m), {});
      return {
        items: db.items.length,
        blocks: db.blocks.length,
        mobs: db.mobs.length,
        recipes: db.recipes.length,
        categories: { items: cats(db.items), blocks: cats(db.blocks), mobs: cats(db.mobs) },
        imageSources: Object.fromEntries(Object.entries(db.imageSources).map(([k, v]) => [k, v.repository])),
        totalEntries: allEntries(db).length,
      };
    },
  },
];

// ───────────────────────── Protocol handling ─────────────────────────

/** Handle one JSON-RPC message. Returns null for notifications (no response expected). */
export async function handleMessage(db: Database, msg: unknown): Promise<RpcResponse | null> {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
    return { jsonrpc: "2.0", id: null, error: { code: E_INVALID, message: "Invalid Request" } };
  }
  const req = msg as RpcRequest;
  const hasId = Object.prototype.hasOwnProperty.call(req, "id") && req.id !== undefined;

  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return hasId
      ? { jsonrpc: "2.0", id: req.id ?? null, error: { code: E_INVALID, message: "Invalid Request" } }
      : null;
  }
  // Notifications (no id) never get a response.
  if (!hasId) return null;

  const id = req.id as Id;
  try {
    switch (req.method) {
      case "initialize": {
        const requested = req.params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions:
              "Minecraft Bedrock database with Arabic and English names. Use search_minecraft to find items/blocks/mobs, get_recipe for crafting, get_image for image URLs.",
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
        };
      case "tools/call": {
        const name = req.params?.name;
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) throw new RpcError(E_PARAMS, `Unknown tool: ${String(name)}`);
        try {
          const data = tool.run(db, req.params?.arguments ?? {});
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false },
          };
        } catch (err) {
          if (err instanceof RpcError && err.code === E_PARAMS) {
            // Tool-level failures are reported inside the result so the model can see and correct them.
            return {
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: err.message }], isError: true },
            };
          }
          throw err;
        }
      }
      default:
        throw new RpcError(E_METHOD, `Method not found: ${req.method}`);
    }
  } catch (err) {
    if (err instanceof RpcError) return { jsonrpc: "2.0", id, error: { code: err.code, message: err.message } };
    log("internal error:", err);
    return { jsonrpc: "2.0", id, error: { code: E_INTERNAL, message: "Internal error" } };
  }
}

function log(...args: unknown[]) {
  console.error(`[${SERVER_NAME}]`, ...args);
}

// ───────────────────────── stdio transport ─────────────────────────

function runStdio(db: Database) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (r: RpcResponse) => process.stdout.write(JSON.stringify(r) + "\n");
  let pending = 0;
  let closed = false;
  const maybeExit = () => {
    if (closed && pending === 0) process.exit(0);
  };

  rl.on("line", (line) => {
    if (line.trim() === "") return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: E_PARSE, message: "Parse error" } });
      return;
    }
    pending++;
    const batch = Array.isArray(msg) ? msg : [msg];
    Promise.all(batch.map((m) => handleMessage(db, m)))
      .then((responses) => {
        const out = responses.filter((r): r is RpcResponse => r !== null);
        if (Array.isArray(msg)) {
          if (out.length) process.stdout.write(JSON.stringify(out) + "\n");
        } else if (out[0]) send(out[0]);
      })
      .finally(() => {
        pending--;
        maybeExit();
      });
  });
  rl.on("close", () => {
    closed = true;
    maybeExit();
  });
  log(`stdio ready (${allEntries(db).length} entries, ${db.recipes.length} recipes)`);
}

// ───────────────────────── HTTP transport ─────────────────────────

const MAX_BODY = 1_000_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new RpcError(E_INVALID, "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...extra });
  res.end(JSON.stringify(body));
}

export function createHttpServer(db: Database, env: NodeJS.ProcessEnv = process.env) {
  const token = env.MCP_AUTH_TOKEN;
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/health" && req.method === "GET") {
        return json(res, 200, { status: "ok", name: SERVER_NAME, version: SERVER_VERSION });
      }
      if (url.pathname !== "/mcp") return json(res, 404, { error: "Not found. MCP endpoint is POST /mcp" });

      // DNS-rebinding protection: browsers send Origin; native MCP clients normally do not.
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.includes(origin)) return json(res, 403, { error: "Origin not allowed" });

      if (token && req.headers.authorization !== `Bearer ${token}`) {
        return json(res, 401, { error: "Unauthorized" }, { "WWW-Authenticate": "Bearer" });
      }
      if (req.method !== "POST") return json(res, 405, { error: "Use POST" }, { Allow: "POST" });

      let msg: unknown;
      try {
        msg = JSON.parse(await readBody(req));
      } catch (err) {
        if (err instanceof RpcError) return json(res, 413, { error: err.message });
        return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: E_PARSE, message: "Parse error" } });
      }

      const batch = Array.isArray(msg) ? msg : [msg];
      const responses = (await Promise.all(batch.map((m) => handleMessage(db, m)))).filter(
        (r): r is RpcResponse => r !== null
      );
      if (responses.length === 0) {
        res.writeHead(202);
        return res.end();
      }
      return json(res, 200, Array.isArray(msg) ? responses : responses[0]);
    } catch (err) {
      log("http error:", err);
      if (!res.headersSent) json(res, 500, { error: "Internal error" });
    }
  });
}

function runHttp(db: Database) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  const server = createHttpServer(db);
  server.listen(port, host, () => {
    log(`HTTP ready on http://${host}:${port}/mcp  (auth ${process.env.MCP_AUTH_TOKEN ? "ON" : "OFF"})`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

// ───────────────────────── Entry point ─────────────────────────

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    const db = loadDatabase();
    if (process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http") runHttp(db);
    else runStdio(db);
  } catch (err) {
    log("fatal:", (err as Error).message);
    process.exit(1);
  }
}

export { getById };
