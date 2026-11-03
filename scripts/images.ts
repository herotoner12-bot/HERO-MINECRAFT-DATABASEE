/**
 * Image tools (need internet):
 *   tsx scripts/images.ts verify     — check that every image URL in the database is reachable (HTTP 200, image/*)
 *   tsx scripts/images.ts download   — save every image into images/<type>s/<id>.png (also verifies)
 * Exit code 1 if any URL fails, so you can use it in CI.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { allEntries, imageUrl, loadDatabase, shortId } from "../shared/db.js";

const mode = process.argv[2];
if (mode !== "verify" && mode !== "download") {
  console.error("Usage: tsx scripts/images.ts <verify|download>");
  process.exit(2);
}
const db = loadDatabase();
const entries = allEntries(db);
let ok = 0;
const failed: string[] = [];

async function check(e: (typeof entries)[number]) {
  const url = imageUrl(db, e);
  try {
    const res = await fetch(url, { redirect: "follow" });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!type.startsWith("image/") && !type.startsWith("application/octet-stream")) throw new Error(`content-type ${type}`);
    if (mode === "download") {
      const dir = path.join(db.root, "images", `${e.type}s`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${shortId(e.id)}.png`), Buffer.from(await res.arrayBuffer()));
    } else {
      await res.arrayBuffer();
    }
    ok++;
  } catch (err) {
    failed.push(`${e.id}  ${url}  → ${(err as Error).message}`);
  }
}

const queue = [...entries];
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let e = queue.shift(); e; e = queue.shift()) await check(e);
  })
);
console.log(`${mode}: ${ok}/${entries.length} OK`);
if (failed.length) {
  console.error(failed.map((f) => `✗ ${f}`).join("\n"));
  console.error("\nFix the 'image.path' of the failing entries in database/*.json (or put your own PNG in images/<type>s/<id>.png).");
  process.exit(1);
}
