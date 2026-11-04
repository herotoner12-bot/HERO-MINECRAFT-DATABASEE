import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildPhraseIndex, loadDatabase } from "../shared/db.js";
import { buildFilterGraph, matchTranscript, parseCuesJson, parseSubtitles, parseTranscript, renderVideo, resolveCues, scheduleCues } from "../video-editor/editor.js";

const db = loadDatabase();
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

test("SRT parsing and word timing", () => {
  const srt = "1\n00:00:01,000 --> 00:00:03,000\nHello diamond sword\n\n2\n00:01:00,500 --> 00:01:02,000\nمرحبا\n";
  const segs = parseSubtitles(srt);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].start, 1);
  assert.equal(segs[1].start, 60.5);
  const tokens = parseTranscript(srt, "x.srt");
  assert.equal(tokens[0].norm, "hello");
  assert.ok(tokens[1].start > 1 && tokens[1].start < 3);
});

test("transcript → cues (Arabic + English, longest phrase wins, cooldown)", () => {
  const srt = `1
00:00:00,000 --> 00:00:04,000
a diamond sword and a diamond sword again

2
00:00:10,000 --> 00:00:14,000
سيف الألماس مع الكريبر والفرن
`;
  const cues = matchTranscript(parseTranscript(srt, "t.srt"), buildPhraseIndex(db), { cooldown: 3 });
  const ids = cues.map((c) => c.id);
  assert.ok(ids.includes("minecraft:diamond_sword"));
  assert.ok(!ids.includes("minecraft:diamond"), "'diamond sword' must win over 'diamond'");
  assert.ok(ids.includes("minecraft:creeper"));
  assert.ok(ids.includes("minecraft:furnace"));
  // the 2nd English mention is <3s after the 1st (cooldown drops it); the Arabic one at 10s is kept
  assert.equal(ids.filter((i) => i === "minecraft:diamond_sword").length, 2);
});

test("cue validation and scheduling", () => {
  assert.throws(() => parseCuesJson("[]"));
  assert.throws(() => parseCuesJson('[{"at":-1,"id":"x"}]'));
  assert.throws(() => parseCuesJson('[{"at":1,"id":"x","animation":"spin"}]'));
  const mk = (at: number, duration: number) => ({ at, duration, imagePath: "x", animation: "pop" as const, size: 600, label: "l" });
  const warns: string[] = [];
  const s = scheduleCues([mk(3, 2), mk(1, 5), mk(9.9, 2)], 10, (m) => warns.push(m));
  assert.equal(s.length, 2);
  assert.equal(s[0].end, 3); // trimmed by next cue
  assert.equal(warns.length, 1); // third starts too close to the end
});

test("filter graph is well-formed", () => {
  const g = buildFilterGraph(
    [{ at: 1, end: 3, duration: 2, imagePath: "a", animation: "pop", size: 640, label: "a", srcWidth: 16, srcHeight: 16 }],
    { total: 5, fps: 30, bg: "#14181f", vignette: true }
  );
  assert.match(g, /^color=c=0x14181f:s=1080x1920:r=30/);
  assert.match(g, /\[vout\]$/);
  assert.match(g, /flags=neighbor/);
  assert.match(g, /enable='between\(t,1,3\)'/);
});

test("render: 1080x1920 H.264 MP4 with audio; images appear and animate", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hero-test-"));
  const sh = (args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);
  sh(["-f", "lavfi", "-i", "sine=frequency=440:duration=4", path.join(dir, "a.wav")]);
  sh(["-f", "lavfi", "-i", "color=c=0xff00ff:s=16x16", "-frames:v", "1", path.join(dir, "m.png")]);
  writeFileSync(path.join(dir, "cues.json"), JSON.stringify([{ at: 1, duration: 2, image: "m.png", animation: "pop" }]));

  const cues = await resolveCues(parseCuesJson(JSON.stringify([{ at: 1, duration: 2, image: "m.png", animation: "pop" }])), {
    db, baseDir: dir, cacheDir: path.join(dir, "cache"), defaultDuration: 2, defaultAnimation: "pop", defaultSize: 640,
  });
  const out = path.join(dir, "out.mp4");
  await renderVideo({ audio: path.join(dir, "a.wav"), out, cues });

  const probe = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height,pix_fmt,display_aspect_ratio", "-show_entries", "format=duration", "-of", "json", out]).toString()
  );
  const v = probe.streams.find((s: any) => s.codec_name === "h264");
  assert.equal(v.width, 1080);
  assert.equal(v.height, 1920);
  assert.equal(v.display_aspect_ratio, "9:16");
  assert.equal(v.pix_fmt, "yuv420p");
  assert.ok(probe.streams.some((s: any) => s.codec_name === "aac"));
  assert.ok(Math.abs(Number(probe.format.duration) - 4) < 0.2);

  const center = (t: number) =>
    [...execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", out, "-frames:v", "1", "-vf", "crop=1:1:540:960,format=rgb24", "-f", "rawvideo", "-"])];
  const before = center(0.3);
  const during = center(2);
  assert.ok(before[0] < 60 && before[1] < 60, "background before the cue");
  assert.ok(during[0] > 200 && during[1] < 60 && during[2] > 200, "magenta image during the cue");
});
