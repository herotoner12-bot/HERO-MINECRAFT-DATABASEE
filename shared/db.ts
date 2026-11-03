import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ───────────────────────── Types ─────────────────────────

export type EntryType = "item" | "block" | "mob";

export interface LocalizedName {
  en: string;
  ar: string;
}

export interface ImageRef {
  source: string;
  path: string;
}

export interface ImageSource {
  name: string;
  repository: string;
  baseUrl: string;
  notes?: string;
}

export interface RawEntry {
  id: string;
  name: LocalizedName;
  aliases?: { en?: string[]; ar?: string[] };
  category: string;
  image: ImageRef;
}

export interface Entry extends RawEntry {
  type: EntryType;
}

export type RecipeIngredient = { id: string } | { tag: string };

export interface Recipe {
  id: string;
  type: "crafting_shaped" | "crafting_shapeless" | "smelting";
  result: { id: string; count: number };
  pattern?: string[];
  key?: Record<string, RecipeIngredient>;
  ingredients?: RecipeIngredient[];
  ingredient?: RecipeIngredient;
  station?: string;
}

export interface Database {
  root: string;
  items: Entry[];
  blocks: Entry[];
  mobs: Entry[];
  recipes: Recipe[];
  tags: Record<string, { description?: string }>;
  imageSources: Record<string, ImageSource>;
}

export interface ResolvedImage {
  /** Remote URL of the official texture. */
  url: string;
  /** Absolute path of a local override/download in images/<type>s/, if it exists. */
  localPath: string | null;
  /** Where a local file should be placed to override the remote one. */
  localCandidate: string;
}

export interface SearchHit {
  type: EntryType;
  id: string;
  name: LocalizedName;
  category: string;
  score: number;
  matchedOn: string;
  image: ResolvedImage;
}

// ───────────────────────── Loading ─────────────────────────

export function findProjectRoot(startDir?: string): string {
  if (process.env.HERO_MC_ROOT) return path.resolve(process.env.HERO_MC_ROOT);
  let dir = startDir ?? path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "database", "items.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Cannot locate project root (database/items.json not found). Set HERO_MC_ROOT to the project folder."
  );
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read ${file}: ${(err as Error).message}`);
  }
}

export function loadDatabase(root: string = findProjectRoot()): Database {
  const dbDir = path.join(root, "database");
  const load = (name: string, type: EntryType): { entries: Entry[]; sources: Record<string, ImageSource> } => {
    const j = readJson(path.join(dbDir, name));
    const entries: Entry[] = (j.entries as RawEntry[]).map((e) => ({ ...e, type }));
    return { entries, sources: j.imageSources ?? {} };
  };
  const items = load("items.json", "item");
  const blocks = load("blocks.json", "block");
  const mobs = load("mobs.json", "mob");
  const rec = readJson(path.join(dbDir, "recipes.json"));
  return {
    root,
    items: items.entries,
    blocks: blocks.entries,
    mobs: mobs.entries,
    recipes: rec.entries as Recipe[],
    tags: rec.tags ?? {},
    imageSources: { ...items.sources, ...blocks.sources, ...mobs.sources },
  };
}

export function allEntries(db: Database): Entry[] {
  return [...db.items, ...db.blocks, ...db.mobs];
}

export function entriesOfType(db: Database, type: EntryType): Entry[] {
  return type === "item" ? db.items : type === "block" ? db.blocks : db.mobs;
}

// ───────────────────────── Images ─────────────────────────

export function shortId(id: string): string {
  return id.replace(/^minecraft:/, "");
}

export function imageUrl(db: Database, entry: Entry): string {
  const src = db.imageSources[entry.image.source];
  if (!src) throw new Error(`Unknown image source "${entry.image.source}" for ${entry.id}`);
  return src.baseUrl + entry.image.path;
}

export function resolveImage(db: Database, entry: Entry): ResolvedImage {
  const candidate = path.join(db.root, "images", `${entry.type}s`, `${shortId(entry.id)}.png`);
  return {
    url: imageUrl(db, entry),
    localPath: existsSync(candidate) ? candidate : null,
    localCandidate: candidate,
  };
}

// ───────────────────────── Text normalisation ─────────────────────────

/** Lower-case, strip Arabic diacritics/tatweel, unify alef/yeh/teh-marbuta/hamza forms, drop punctuation. */
export function normalizeText(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/\u0640/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/^minecraft:/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Canonical form of a single (already normalised) token so that
 * "الماس" / "الألماس" / "بالألماس" / "للألماس" and "diamonds" / "diamond" compare equal.
 * Heuristic, intentionally simple.
 */
export function canonToken(token: string): string {
  if (/^[a-z0-9]+$/.test(token)) {
    return token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
  }
  let cur = token;
  for (let i = 0; i < 3; i++) {
    let next = cur;
    if (/^[وفبك]ال/.test(cur)) next = cur.slice(3);
    else if (cur.startsWith("لل")) next = cur.slice(2);
    else if (cur.startsWith("ال")) next = cur.slice(2);
    if (next !== cur && next.length >= 3) cur = next;
    else break;
  }
  return cur;
}

export function canonTokens(text: string): string[] {
  const n = normalizeText(text);
  return n === "" ? [] : n.split(" ").map(canonToken);
}

export function canonKey(text: string): string {
  return canonTokens(text).join(" ");
}

function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    let rowMin = prev[0];
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
      if (prev[j] < rowMin) rowMin = prev[j];
    }
    if (rowMin > max) return max + 1;
  }
  return prev[b.length];
}

// ───────────────────────── Name index & search ─────────────────────────

export interface NameForm {
  label: string; // original text
  tokens: string[]; // canonical tokens
  key: string; // tokens.join(" ")
}

export function namesOf(entry: Entry): NameForm[] {
  const labels = [
    shortId(entry.id).replace(/_/g, " "),
    entry.id,
    entry.name.en,
    entry.name.ar,
    ...(entry.aliases?.en ?? []),
    ...(entry.aliases?.ar ?? []),
  ];
  const seen = new Set<string>();
  const out: NameForm[] = [];
  for (const label of labels) {
    const tokens = canonTokens(label);
    if (tokens.length === 0) continue;
    const key = tokens.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, tokens, key });
  }
  return out;
}

function scoreName(q: { tokens: string[]; key: string }, n: NameForm): number {
  if (n.key === q.key) return 100;
  const nTok = n.tokens;
  const qTok = q.tokens;
  if (n.key.startsWith(q.key + " ")) return 85; // name begins with the query's whole tokens
  if (` ${n.key} `.includes(` ${q.key} `)) return 75; // query is a contiguous token run inside the name
  if (qTok.every((t) => nTok.includes(t))) return 65; // every query token appears
  if (qTok.every((t) => nTok.some((nt) => nt.startsWith(t) && t.length >= 2))) return 55; // token prefixes
  if (q.key.length >= 4) {
    const maxDist = q.key.length >= 8 ? 2 : 1;
    const d = levenshtein(q.key, n.key, maxDist);
    if (d <= maxDist) return 45 - d * 5; // typo tolerance
  }
  return 0;
}

export interface SearchOptions {
  types?: EntryType[];
  limit?: number;
  minScore?: number;
}

export function search(db: Database, query: string, opts: SearchOptions = {}): SearchHit[] {
  const q = { tokens: canonTokens(query), key: canonKey(query) };
  if (q.tokens.length === 0) return [];
  const types = opts.types ?? ["item", "block", "mob"];
  const limit = opts.limit ?? 10;
  const minScore = opts.minScore ?? 40;
  const hits: SearchHit[] = [];
  for (const entry of allEntries(db)) {
    if (!types.includes(entry.type)) continue;
    let best = 0;
    let matchedOn = "";
    for (const n of namesOf(entry)) {
      const s = scoreName(q, n);
      if (s > best) {
        best = s;
        matchedOn = n.label;
      }
    }
    if (best >= minScore) {
      hits.push({
        type: entry.type,
        id: entry.id,
        name: entry.name,
        category: entry.category,
        score: best,
        matchedOn,
        image: resolveImage(db, entry),
      });
    }
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.name.en.length - b.name.en.length ||
      a.id.localeCompare(b.id)
  );
  return hits.slice(0, limit);
}

/** Exact lookup by id ("minecraft:diamond" or "diamond"). */
export function getById(db: Database, id: string, type?: EntryType): Entry | undefined {
  const wanted = shortId(id.trim().toLowerCase());
  return allEntries(db).find((e) => (!type || e.type === type) && shortId(e.id) === wanted);
}

/** Resolve an id first, then fall back to the best search hit. */
export function lookup(db: Database, idOrName: string, type?: EntryType): Entry | undefined {
  const byId = getById(db, idOrName, type);
  if (byId) return byId;
  const hit = search(db, idOrName, { types: type ? [type] : undefined, limit: 1, minScore: 55 })[0];
  return hit ? getById(db, hit.id, hit.type) : undefined;
}

// ───────────────────────── Recipes ─────────────────────────

export function recipesProducing(db: Database, id: string): Recipe[] {
  const sid = shortId(id);
  return db.recipes.filter((r) => shortId(r.result.id) === sid);
}

export function recipeIngredientIds(r: Recipe): string[] {
  const refs: RecipeIngredient[] = [
    ...Object.values(r.key ?? {}),
    ...(r.ingredients ?? []),
    ...(r.ingredient ? [r.ingredient] : []),
  ];
  return refs.filter((x): x is { id: string } => "id" in x).map((x) => x.id);
}

export function recipesUsing(db: Database, id: string): Recipe[] {
  const sid = shortId(id);
  return db.recipes.filter((r) => recipeIngredientIds(r).some((i) => shortId(i) === sid));
}

// ───────────────────────── Phrase index (used by the video editor) ─────────────────────────

export interface PhraseIndex {
  map: Map<string, Entry[]>;
  maxTokens: number;
}

/** Map of canonical name key -> entries, for matching transcript text against the database. */
export function buildPhraseIndex(db: Database): PhraseIndex {
  const map = new Map<string, Entry[]>();
  let maxTokens = 1;
  for (const entry of allEntries(db)) {
    for (const n of namesOf(entry)) {
      if (n.key.length < 3) continue;
      // The "minecraft:foo" label would normalise to the same key as the short id; skip duplicates per entry.
      const list = map.get(n.key) ?? [];
      if (!list.includes(entry)) list.push(entry);
      map.set(n.key, list);
      maxTokens = Math.max(maxTokens, n.tokens.length);
    }
  }
  return { map, maxTokens };
}
