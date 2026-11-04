import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPhraseIndex, canonToken, loadDatabase, lookup, normalizeText, recipesProducing, search } from "../shared/db.js";

const db = loadDatabase();
const top = (q: string, types?: any) => search(db, q, { types, limit: 1 })[0]?.id;

test("English search: exact, plural, typo, id", () => {
  assert.equal(top("Diamond Sword"), "minecraft:diamond_sword");
  assert.equal(top("creepers"), "minecraft:creeper");
  assert.equal(top("enderrman"), "minecraft:enderman");
  assert.equal(top("minecraft:tnt"), "minecraft:tnt");
});

test("Arabic search: names, aliases, diacritics, definite article", () => {
  assert.equal(top("سيف ألماس"), "minecraft:diamond_sword");
  assert.equal(top("سيف الماس"), "minecraft:diamond_sword");
  assert.equal(top("الكريبر"), "minecraft:creeper");
  assert.equal(top("طاولة الصناعة"), "minecraft:crafting_table");
  assert.equal(top("الهَيكل العظمي"), "minecraft:skeleton");
  assert.equal(top("بالألماس"), "minecraft:diamond");
});

test("type filter", () => {
  assert.equal(search(db, "diamond", { types: ["mob"] }).length, 0);
  assert.ok(search(db, "diamond", { types: ["block"] }).some((h) => h.id === "minecraft:diamond_ore"));
});

test("images: official URLs derived from the database, no invented hosts", () => {
  for (const hit of search(db, "creeper")) {
    assert.match(hit.image.url, /^https:\/\/raw\.githubusercontent\.com\/Mojang\/bedrock-samples\/main\/resource_pack\/textures\/.+\.png$/);
  }
});

test("recipes", () => {
  assert.equal(recipesProducing(db, "minecraft:stick")[0].result.count, 4);
  assert.equal(lookup(db, "فرن")?.id, "minecraft:furnace");
});

test("normalisation helpers", () => {
  assert.equal(normalizeText("  Ŧhe  أَلْمَاس! "), "ŧhe المس".replace("المس", "الماس"));
  assert.equal(canonToken("الالماس"), canonToken("الماس"));
  assert.equal(canonToken("diamonds"), "diamond");
  assert.equal(canonToken("glass"), "glass");
  assert.ok(buildPhraseIndex(db).map.has("diamond sword"));
});
