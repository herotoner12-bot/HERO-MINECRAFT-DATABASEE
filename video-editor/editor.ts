#!/usr/bin/env node
/**
 * HERO Minecraft Database — Video editor.
 *
 * Takes an audio file and a timeline, and renders a vertical MP4 (1080×1920, 9:16, H.264 + AAC) where
 * Minecraft item/block/mob images appear at the right moments with animation. Rendering uses FFmpeg.
 *
 * Timeline sources (use one or both):
 *   --cues <file.json>        explicit cues: [{ "at": 1.2, "id": "minecraft:diamond", "animation": "pop" }, ...]
 *   --transcript <file>       .srt / .vtt / .json with timestamps (e.g. produced by Whisper). Names of items, blocks
 *                             and mobs (Arabic or English) found in the text become cues automatically.
 *
 * This tool does NOT transcribe speech by itself. To get timestamps from raw audio, generate an SRT or
 * word-level JSON with a speech-to-text tool first (see README).
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildPhraseIndex,
  canonToken,
  loadDatabase,
  lookup,
  normalizeText,
  resolveImage,
  type Database,
  type Entry,
  type EntryType,
  type PhraseIndex,
} from "../shared/db.js";

// ───────────────────────── Constants & types ─────────────────────────

export const VIDEO_WIDTH = 1080;
export const VIDEO_HEIGHT = 1920;
export const ANIMATIONS = ["pop", "zoom", "slide-up", "slide-left", "fade"] as const;
export type Animation = (typeof ANIMATIONS)[number];

/** A cue as written by the user (JSON) or generated from a transcript. */
export interface Cue {
  /** Start time in seconds. */
  at: number;
  /** How long the image stays (seconds). Default: --duration. */
  duration?: number;
  /** Database id ("minecraft:diamond" / "diamond") … */
  id?: string;
  /** … or a search query (Arabic/English) … */
  query?: string;
  /** … or an explicit image file path / http(s) URL. */
  image?: string;
  type?: EntryType;
  animation?: Animation;
  /** Image size in pixels (longest side). Default: --size. */
  size?: number;
}

export interface ResolvedCue {
  at: number;
  duration: number;
  imagePath: string;
  animation: Animation;
  size: number;
  label: string;
}

export interface ScheduledCue extends ResolvedCue {
  end: number;
}

export interface TimedToken {
  norm: string;
  start: number;
  end: number;
}

export interface RenderOptions {
  audio: string;
  out: string;
  cues: ResolvedCue[];
  fps?: number;
  bg?: string;
  vignette?: boolean;
  tail?: number;
  crf?: number;
  preset?: string;
  keepScript?: boolean;
  onProgress?: (fraction: number) => void;
}

// ───────────────────────── External tools ─────────────────────────

const FFMPEG = () => process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = () => process.env.FFPROBE_PATH || "ffprobe";

function exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") {
          reject(
            new Error(
              `"${cmd}" was not found. Install FFmpeg (https://ffmpeg.org/download.html) or set FFMPEG_PATH / FFPROBE_PATH.`
            )
          );
        } else {
          reject(new Error(`${cmd} failed: ${String(stderr || e.message).trim().split("\n").slice(-6).join("\n")}`));
        }
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await exec(FFPROBE(), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  const d = parseFloat(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`Could not read a valid duration from audio file: ${file}`);
  return d;
}

export async function probeSize(file: string): Promise<{ width: number; height: number }> {
  const { stdout } = await exec(FFPROBE(), [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", file,
  ]);
  const m = /^(\d+)x(\d+)/.exec(stdout.trim());
  if (!m) throw new Error(`Could not read image size (is it a valid image?): ${file}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

// ───────────────────────── Transcript parsing ─────────────────────────

const TIME_RE = /(?:(\d+):)?(\d+):(\d+)[,.](\d+)/;

function parseTimestamp(s: string): number {
  const m = TIME_RE.exec(s);
  if (!m) throw new Error(`Bad timestamp: "${s}"`);
  const [, h, mi, se, ms] = m;
  return Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(se) + Number(`0.${ms}`);
}

export interface Segment {
  start: number;
  end: number;
  text: string;
}

/** Parse SRT or WebVTT text into segments. */
export function parseSubtitles(text: string): Segment[] {
  const segments: Segment[] = [];
  for (const block of text.replace(/^\uFEFF/, "").split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const idx = lines.findIndex((l) => l.includes("-->"));
    if (idx === -1) continue;
    const [a, b] = lines[idx].split("-->");
    const body = lines
      .slice(idx + 1)
      .join(" ")
      .replace(/<[^>]+>/g, " ")
      .trim();
    if (body) segments.push({ start: parseTimestamp(a), end: parseTimestamp(b), text: body });
  }
  return segments;
}

/** Spread a segment's words over its time span, proportionally to word length. */
function segmentToTokens(seg: Segment): TimedToken[] {
  const words = normalizeText(seg.text).split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const weights = words.map((w) => w.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const span = Math.max(0, seg.end - seg.start);
  let cursor = seg.start;
  return words.map((w, i) => {
    const len = (weights[i] / total) * span;
    const tok = { norm: w, start: cursor, end: cursor + len };
    cursor += len;
    return tok;
  });
}

function wordToTokens(word: string, start: number, end: number): TimedToken[] {
  const parts = normalizeText(word).split(" ").filter(Boolean);
  if (parts.length === 0) return [];
  const step = (end - start) / parts.length;
  return parts.map((p, i) => ({ norm: p, start: start + i * step, end: start + (i + 1) * step }));
}

/** Parse a transcript (.srt, .vtt or .json) into timed tokens. */
export function parseTranscript(content: string, filename: string): TimedToken[] {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".json") {
    const data = JSON.parse(content);
    const tokens: TimedToken[] = [];
    const items: any[] = Array.isArray(data) ? data : Array.isArray(data?.segments) ? data.segments : [];
    if (items.length === 0) throw new Error("Transcript JSON must be an array of words/segments or an object with \"segments\".");
    for (const it of items) {
      if (Array.isArray(it.words) && it.words.length) {
        for (const w of it.words) tokens.push(...wordToTokens(String(w.word ?? w.text ?? ""), Number(w.start), Number(w.end)));
      } else if (typeof (it.word ?? it.text) === "string") {
        const text = String(it.word ?? it.text);
        const start = Number(it.start);
        const end = Number(it.end);
        if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("Transcript JSON entries need numeric start/end (seconds).");
        // Whisper-style segments have several words; word-level entries have one. Same handling covers both.
        tokens.push(...segmentToTokens({ start, end, text }));
      }
    }
    return tokens;
  }
  if (ext === ".srt" || ext === ".vtt") {
    return parseSubtitles(content).flatMap(segmentToTokens);
  }
  throw new Error(`Unsupported transcript format "${ext}". Use .srt, .vtt or .json.`);
}

// ───────────────────────── Transcript → cues ─────────────────────────

export interface MatchOptions {
  /** Preference order when a name matches several entries. */
  prefer?: EntryType[];
  /** Seconds before the spoken word that the image should appear. */
  lead?: number;
  /** Do not show the same entry again within this many seconds. */
  cooldown?: number;
  duration?: number;
  animation?: Animation;
  maxPhraseTokens?: number;
}

export interface MatchedCue extends Cue {
  id: string;
  type: EntryType;
  matchedText: string;
}

export function matchTranscript(
  tokens: TimedToken[],
  index: PhraseIndex,
  opts: MatchOptions = {}
): MatchedCue[] {
  const prefer = opts.prefer ?? ["item", "block", "mob"];
  const lead = opts.lead ?? 0.15;
  const cooldown = opts.cooldown ?? 3;
  const maxN = Math.min(opts.maxPhraseTokens ?? 4, index.maxTokens);
  const canon = tokens.map((t) => canonToken(t.norm));
  const cues: MatchedCue[] = [];
  const lastShown = new Map<string, number>();

  let i = 0;
  while (i < tokens.length) {
    let matched = false;
    for (let n = Math.min(maxN, tokens.length - i); n >= 1; n--) {
      const key = canon.slice(i, i + n).join(" ");
      const candidates = index.map.get(key);
      if (!candidates) continue;
      const entry = [...candidates].sort((a, b) => prefer.indexOf(a.type) - prefer.indexOf(b.type))[0];
      const at = Math.max(0, tokens[i].start - lead);
      const prev = lastShown.get(entry.id);
      if (prev === undefined || at - prev >= cooldown) {
        lastShown.set(entry.id, at);
        cues.push({
          at: round3(at),
          id: entry.id,
          type: entry.type,
          duration: opts.duration,
          animation: opts.animation,
          matchedText: tokens.slice(i, i + n).map((t) => t.norm).join(" "),
        });
      }
      i += n;
      matched = true;
      break;
    }
    if (!matched) i++;
  }
  return cues;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ───────────────────────── Cue loading & resolution ─────────────────────────

export function parseCuesJson(content: string): Cue[] {
  const data = JSON.parse(content);
  const list: any[] = Array.isArray(data) ? data : Array.isArray(data?.cues) ? data.cues : [];
  if (list.length === 0) throw new Error('Cues file must be a non-empty array, or an object with a "cues" array.');
  return list.map((c, i) => {
    if (typeof c !== "object" || c === null) throw new Error(`cues[${i}] must be an object`);
    if (typeof c.at !== "number" || !(c.at >= 0)) throw new Error(`cues[${i}].at must be a number of seconds >= 0`);
    if (c.duration !== undefined && !(typeof c.duration === "number" && c.duration > 0)) throw new Error(`cues[${i}].duration must be > 0`);
    if (!c.id && !c.query && !c.image) throw new Error(`cues[${i}] needs one of: id, query, image`);
    if (c.animation !== undefined && !(ANIMATIONS as readonly string[]).includes(c.animation)) {
      throw new Error(`cues[${i}].animation must be one of: ${ANIMATIONS.join(", ")}`);
    }
    return c as Cue;
  });
}

async function downloadToCache(url: string, cacheDir: string): Promise<string> {
  const ext = path.extname(new URL(url).pathname) || ".png";
  const file = path.join(cacheDir, createHash("sha1").update(url).digest("hex") + ext);
  if (existsSync(file)) return file;
  mkdirSync(cacheDir, { recursive: true });
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (err) {
    throw new Error(`Could not download ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`Could not download ${url}: HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("image/") && !type.startsWith("application/octet-stream")) {
    throw new Error(`Unexpected content-type "${type}" for ${url}`);
  }
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

export interface ResolveOptions {
  db: Database;
  baseDir: string;
  cacheDir: string;
  defaultDuration: number;
  defaultAnimation: Animation;
  defaultSize: number;
}

export async function resolveCues(cues: Cue[], o: ResolveOptions): Promise<ResolvedCue[]> {
  const out: ResolvedCue[] = [];
  for (const [i, c] of cues.entries()) {
    let imagePath: string;
    let label: string;
    if (c.image) {
      label = c.image;
      if (/^https?:\/\//i.test(c.image)) imagePath = await downloadToCache(c.image, o.cacheDir);
      else {
        imagePath = path.resolve(o.baseDir, c.image);
        if (!existsSync(imagePath)) throw new Error(`cues[${i}]: image file not found: ${imagePath}`);
      }
    } else {
      const entry: Entry | undefined = lookup(o.db, (c.id ?? c.query)!, c.type);
      if (!entry) throw new Error(`cues[${i}]: nothing in the database matches "${c.id ?? c.query}"`);
      label = `${entry.name.en} / ${entry.name.ar}`;
      const img = resolveImage(o.db, entry);
      imagePath = img.localPath ?? (await downloadToCache(img.url, o.cacheDir));
    }
    out.push({
      at: c.at,
      duration: c.duration ?? o.defaultDuration,
      imagePath,
      animation: c.animation ?? o.defaultAnimation,
      size: c.size ?? o.defaultSize,
      label,
    });
  }
  return out;
}

/** Sort, trim overlaps (a cue ends when the next begins), clip to the audio, drop unusable cues. */
export function scheduleCues(cues: ResolvedCue[], total: number, warn: (m: string) => void = () => {}): ScheduledCue[] {
  const MIN = 0.25;
  const sorted = [...cues].sort((a, b) => a.at - b.at);
  const out: ScheduledCue[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    if (c.at >= total - MIN) {
      warn(`dropped "${c.label}" at ${c.at}s: starts at/after the end of the audio (${total.toFixed(2)}s)`);
      continue;
    }
    let end = Math.min(c.at + c.duration, total);
    const next = sorted[i + 1];
    if (next && next.at < end) end = next.at;
    if (end - c.at < MIN) {
      warn(`dropped "${c.label}" at ${c.at}s: only ${(end - c.at).toFixed(2)}s before the next cue (minimum ${MIN}s)`);
      continue;
    }
    out.push({ ...c, end, duration: end - c.at });
  }
  return out;
}

// ───────────────────────── FFmpeg filter graph ─────────────────────────

const f = (n: number) => String(Number(n.toFixed(4)));

/** Expressions for the animated width and the overlay position of one cue. */
export function animationExpressions(anim: Animation, base: number, dur: number, start: number, fadeOut: number) {
  const exit = `(1-0.12*max(0,min(1,(t-${f(dur - fadeOut)})/${f(fadeOut)})))`;
  let w: string;
  switch (anim) {
    case "pop": // ease-out-back: starts at 0, overshoots ~10%, settles
      w = `${base}*(1+2.70158*pow(min(t/0.4,1)-1,3)+1.70158*pow(min(t/0.4,1)-1,2))*${exit}`;
      break;
    case "zoom": // smooth ease-out-cubic growth + slow push-in
      w = `${base}*(0.75+0.25*(1-pow(1-min(t/0.5,1),3)))*(1+0.04*t/${f(dur)})*${exit}`;
      break;
    default:
      w = `${base}*(1+0.04*t/${f(dur)})*${exit}`;
  }
  const slide = `pow(max(0,1-(t-${f(start)})/0.45),3)`;
  const bob = `14*sin(2*PI*(t-${f(start)})/2.4)`;
  const x = anim === "slide-left" ? `(W-w)/2+520*${slide}` : `(W-w)/2`;
  const y = anim === "slide-up" ? `(H-h)/2+520*${slide}-${bob}` : `(H-h)/2-${bob}`;
  return { w: `max(2,trunc(${w}))`, x, y };
}

export interface GraphInput extends ScheduledCue {
  /** Source image pixel size (for choosing the scaler). */
  srcWidth: number;
  srcHeight: number;
}

export function buildFilterGraph(
  cues: GraphInput[],
  o: { total: number; fps: number; bg: string; vignette: boolean }
): string {
  const bgHex = "0x" + o.bg.replace(/^#/, "");
  const lines: string[] = [];
  lines.push(
    `color=c=${bgHex}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:r=${o.fps}:d=${f(o.total)},setsar=1,format=yuv420p${o.vignette ? ",vignette=PI/5" : ""}[bg0]`
  );
  if (cues.length === 0) {
    lines.push(`[bg0]null[vout]`);
    return lines.join(";\n");
  }
  cues.forEach((c, i) => {
    const k = i + 1; // input 0 is audio
    const base = Math.max(
      2,
      Math.round(c.srcWidth >= c.srcHeight ? c.size : (c.size * c.srcWidth) / c.srcHeight)
    );
    const fi = Math.min(0.25, c.duration * 0.3);
    const fo = Math.min(0.3, c.duration * 0.3);
    const ex = animationExpressions(c.animation, base, c.duration, c.at, fo);
    const flags = Math.max(c.srcWidth, c.srcHeight) <= 256 ? "neighbor" : "bicubic"; // keep pixel art crisp
    lines.push(
      `[${k}:v]format=rgba,` +
        `fade=t=in:st=0:d=${f(fi)}:alpha=1,fade=t=out:st=${f(c.duration - fo)}:d=${f(fo)}:alpha=1,` +
        `scale=w='${ex.w}':h=-2:flags=${flags}:eval=frame,setpts=PTS+${f(c.at)}/TB[c${i}]`
    );
    lines.push(
      `[bg${i}][c${i}]overlay=x='${ex.x}':y='${ex.y}':enable='between(t,${f(c.at)},${f(c.end)})':eof_action=pass:format=auto[bg${i + 1}]`
    );
  });
  lines.push(`[bg${cues.length}]format=yuv420p[vout]`);
  return lines.join(";\n");
}

// ───────────────────────── Rendering ─────────────────────────

export async function renderVideo(opts: RenderOptions): Promise<{ out: string; duration: number; filterGraph: string; cues: ScheduledCue[] }> {
  const fps = opts.fps ?? 30;
  const audioDuration = await probeDuration(opts.audio);
  const total = audioDuration + (opts.tail ?? 0);
  const warnings: string[] = [];
  const scheduled = scheduleCues(opts.cues, audioDuration, (m) => warnings.push(m));
  warnings.forEach((w) => console.error(`warning: ${w}`));

  const graphInputs: GraphInput[] = [];
  for (const c of scheduled) {
    const { width, height } = await probeSize(c.imagePath);
    graphInputs.push({ ...c, srcWidth: width, srcHeight: height });
  }
  const graph = buildFilterGraph(graphInputs, {
    total,
    fps,
    bg: opts.bg ?? "#14181f",
    vignette: opts.vignette ?? true,
  });

  const workDir = mkdtempSync(path.join(tmpdir(), "hero-mc-"));
  const scriptPath = path.join(workDir, "filter.txt");
  writeFileSync(scriptPath, graph, "utf8");

  mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-i", opts.audio];
  for (const c of scheduled) args.push("-framerate", String(fps), "-loop", "1", "-t", f(c.duration), "-i", c.imagePath);
  args.push(
    "-filter_complex_script", scriptPath,
    "-map", "[vout]", "-map", "0:a:0",
    "-c:v", "libx264", "-preset", opts.preset ?? "medium", "-crf", String(opts.crf ?? 18),
    "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(fps),
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    "-t", f(total),
    opts.out
  );

  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(FFMPEG(), args, { stdio: ["ignore", "pipe", "pipe"] });
      let errBuf = "";
      p.stderr.on("data", (d: Buffer) => (errBuf = (errBuf + d.toString()).slice(-4000)));
      p.stdout.on("data", (d: Buffer) => {
        const m = /out_time_ms=(\d+)/.exec(d.toString());
        if (m && opts.onProgress) opts.onProgress(Math.min(1, Number(m[1]) / 1e6 / total));
      });
      p.on("error", (e: NodeJS.ErrnoException) =>
        reject(e.code === "ENOENT" ? new Error(`"${FFMPEG()}" was not found. Install FFmpeg or set FFMPEG_PATH.`) : e)
      );
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}:\n${errBuf.trim()}`))));
    });
  } finally {
    if (opts.keepScript) console.error(`filter script kept at ${scriptPath}`);
    else rmSync(workDir, { recursive: true, force: true });
  }
  return { out: opts.out, duration: total, filterGraph: graph, cues: scheduled };
}

// ───────────────────────── CLI ─────────────────────────

const HELP = `
Usage:
  tsx editor.ts --audio voice.mp3 --cues cues.json --out out.mp4
  tsx editor.ts --audio voice.mp3 --transcript voice.srt --out out.mp4

Timeline (at least one):
  --cues <file.json>        Explicit cues. See examples/cues.example.json
  --transcript <file>       .srt / .vtt / .json with timestamps; database names found in the text become cues
  --save-cues <file.json>   Write the cues that were generated from --transcript (to hand-edit and reuse)

Options:
  --audio <file>            Audio file (mp3, wav, m4a, ...)  [required]
  --out <file.mp4>          Output file                      [default: output/video.mp4]
  --animation <name>        ${ANIMATIONS.join(" | ")}         [default: pop]
  --duration <sec>          Default time each image stays    [default: 2.2]
  --size <px>               Image size, longest side         [default: 640]
  --bg <#RRGGBB>            Background colour                [default: #14181f]
  --fps <n>                 Frames per second                [default: 30]
  --lead <sec>              Show image this long before the spoken word [default: 0.15]
  --cooldown <sec>          Don't repeat the same image within this time [default: 3]
  --prefer <types>          Ambiguous names: order of item,block,mob [default: item,block,mob]
  --no-vignette             Disable the soft vignette
  --tail <sec>              Extra seconds after the audio ends [default: 0]
  --dry-run                 Print the timeline and exit (no download, no render)
  --keep-script             Keep the generated FFmpeg filter script
  --cache-dir <dir>         Where downloaded images are cached [default: .cache/images]
`;

interface CliArgs {
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): CliArgs {
  const flags = new Map<string, string | true>();
  const bool = new Set(["dry-run", "no-vignette", "keep-script", "help"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument: ${a}`);
    const name = a.slice(2);
    if (bool.has(name)) flags.set(name, true);
    else {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`Option --${name} needs a value`);
      flags.set(name, v);
    }
  }
  return { flags };
}

function num(flags: Map<string, string | true>, name: string, def: number, min = 0): number {
  const v = flags.get(name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new Error(`--${name} must be a number >= ${min}`);
  return n;
}

export async function main(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  if (flags.has("help") || argv.length === 0) {
    console.log(HELP);
    return 0;
  }
  const audio = flags.get("audio");
  const cuesFile = flags.get("cues");
  const transcriptFile = flags.get("transcript");
  if (typeof audio !== "string") throw new Error("--audio is required");
  if (!existsSync(audio)) throw new Error(`Audio file not found: ${audio}`);
  if (typeof cuesFile !== "string" && typeof transcriptFile !== "string") throw new Error("Provide --cues and/or --transcript");

  const animation = (flags.get("animation") as string | undefined) ?? "pop";
  if (!(ANIMATIONS as readonly string[]).includes(animation)) throw new Error(`--animation must be one of: ${ANIMATIONS.join(", ")}`);
  const prefer = ((flags.get("prefer") as string | undefined) ?? "item,block,mob").split(",").map((s) => s.trim()) as EntryType[];
  if (prefer.some((p) => !["item", "block", "mob"].includes(p))) throw new Error("--prefer must list item, block, mob");

  const duration = num(flags, "duration", 2.2, 0.25);
  const db = loadDatabase();
  let cues: Cue[] = [];
  let baseDir = process.cwd();

  if (typeof cuesFile === "string") {
    cues.push(...parseCuesJson(readFileSync(cuesFile, "utf8")));
    baseDir = path.dirname(path.resolve(cuesFile));
  }
  if (typeof transcriptFile === "string") {
    const tokens = parseTranscript(readFileSync(transcriptFile, "utf8"), transcriptFile);
    const matched = matchTranscript(tokens, buildPhraseIndex(db), {
      prefer,
      lead: num(flags, "lead", 0.15),
      cooldown: num(flags, "cooldown", 3),
      duration,
      animation: animation as Animation,
    });
    console.error(`transcript: ${tokens.length} words, ${matched.length} database matches`);
    cues.push(...matched.map(({ matchedText: _m, ...c }) => c));
    if (typeof flags.get("save-cues") === "string") {
      writeFileSync(flags.get("save-cues") as string, JSON.stringify(matched.map(({ matchedText, ...c }) => ({ ...c, _heard: matchedText })), null, 2) + "\n");
      console.error(`saved generated cues to ${flags.get("save-cues")}`);
    }
  }
  if (cues.length === 0) console.error("warning: no cues — the video will only show the background and audio");

  if (flags.has("dry-run")) {
    for (const c of [...cues].sort((a, b) => a.at - b.at)) {
      console.log(`${c.at.toFixed(2).padStart(7)}s  ${(c.id ?? c.query ?? c.image)!}  ${c.animation ?? animation}`);
    }
    return 0;
  }

  const resolved = await resolveCues(cues, {
    db,
    baseDir,
    cacheDir: (flags.get("cache-dir") as string | undefined) ?? path.join(process.cwd(), ".cache", "images"),
    defaultDuration: duration,
    defaultAnimation: animation as Animation,
    defaultSize: num(flags, "size", 640, 16),
  });

  const out = (flags.get("out") as string | undefined) ?? "output/video.mp4";
  let last = -1;
  const result = await renderVideo({
    audio,
    out,
    cues: resolved,
    fps: num(flags, "fps", 30, 1),
    bg: (flags.get("bg") as string | undefined) ?? "#14181f",
    vignette: !flags.has("no-vignette"),
    tail: num(flags, "tail", 0),
    keepScript: flags.has("keep-script"),
    onProgress: (p) => {
      const pct = Math.floor(p * 100);
      if (pct !== last && pct % 10 === 0) {
        last = pct;
        process.stderr.write(`render ${pct}%\n`);
      }
    },
  });
  console.log(`done: ${result.out}  (${VIDEO_WIDTH}x${VIDEO_HEIGHT}, ${result.duration.toFixed(2)}s, ${result.cues.length} images)`);
  return 0;
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    }
  );
}
