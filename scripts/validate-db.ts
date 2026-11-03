/** Validates the JSON database: structure, unique ids, Arabic+English names, image refs, recipe references. */
import { allEntries, loadDatabase, namesOf, recipeIngredientIds, shortId } from "../shared/db.js";

const db = loadDatabase();
const errors: string[] = [];
const err = (m: string) => errors.push(m);

const seen = new Map<string, string>();
for (const e of allEntries(db)) {
  const key = `${e.type}:${e.id}`;
  if (seen.has(key)) err(`duplicate ${key}`);
  seen.set(key, e.id);
  if (!/^minecraft:[a-z0-9_]+$/.test(e.id)) err(`${e.id}: id must match minecraft:[a-z0-9_]+`);
  if (!e.name?.en?.trim()) err(`${e.id}: missing English name`);
  if (!e.name?.ar?.trim()) err(`${e.id}: missing Arabic name`);
  if (!/[\u0600-\u06FF]/.test(e.name?.ar ?? "")) err(`${e.id}: Arabic name has no Arabic letters`);
  if (!e.category) err(`${e.id}: missing category`);
  if (!db.imageSources[e.image?.source]) err(`${e.id}: unknown image source "${e.image?.source}"`);
  if (!/^textures\/[a-z0-9_\/]+\.png$/.test(e.image?.path ?? "")) err(`${e.id}: bad image path "${e.image?.path}"`);
}
// names that collide inside one type make search ambiguous
for (const type of ["item", "block", "mob"] as const) {
  const keys = new Map<string, string>();
  for (const e of allEntries(db).filter((x) => x.type === type)) {
    for (const n of namesOf(e)) {
      const other = keys.get(n.key);
      if (other && other !== e.id) err(`${type}: name "${n.label}" of ${e.id} collides with ${other}`);
      keys.set(n.key, e.id);
    }
  }
}

const known = new Set([...db.items, ...db.blocks].map((e) => shortId(e.id)));
const rids = new Set<string>();
for (const r of db.recipes) {
  if (rids.has(r.id)) err(`duplicate recipe ${r.id}`);
  rids.add(r.id);
  if (!known.has(shortId(r.result.id))) err(`recipe ${r.id}: unknown result ${r.result.id}`);
  for (const i of recipeIngredientIds(r)) if (!known.has(shortId(i))) err(`recipe ${r.id}: unknown ingredient ${i}`);
  const refs = [...Object.values(r.key ?? {}), ...(r.ingredients ?? []), ...(r.ingredient ? [r.ingredient] : [])];
  for (const ref of refs) if ("tag" in ref && !db.tags[ref.tag]) err(`recipe ${r.id}: undeclared tag ${ref.tag}`);
  if (r.type === "crafting_shaped") {
    const used = new Set((r.pattern ?? []).join("").replace(/ /g, "").split(""));
    for (const ch of used) if (!r.key?.[ch]) err(`recipe ${r.id}: pattern symbol "${ch}" missing in key`);
    for (const ch of Object.keys(r.key ?? {})) if (!used.has(ch)) err(`recipe ${r.id}: key "${ch}" unused in pattern`);
    const w = new Set((r.pattern ?? []).map((l) => l.length));
    if (w.size > 1) err(`recipe ${r.id}: pattern rows have different lengths`);
  }
  if (r.type === "smelting" && !r.ingredient) err(`recipe ${r.id}: smelting needs "ingredient"`);
  if (r.type === "crafting_shapeless" && !r.ingredients?.length) err(`recipe ${r.id}: shapeless needs "ingredients"`);
}

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join("\n"));
  console.error(`\n${errors.length} problem(s) found.`);
  process.exit(1);
}
console.log(`✓ database valid: ${db.items.length} items, ${db.blocks.length} blocks, ${db.mobs.length} mobs, ${db.recipes.length} recipes`);
