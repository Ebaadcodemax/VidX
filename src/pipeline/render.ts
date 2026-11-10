import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { editIrSchema, finalClipSchema, type EditIr } from "../schemas/edit-ir";
import { transcriptSchema, type TranscriptDocument, type TranscriptWord } from "../schemas/transcript";
import { mediaDurationSeconds, probeMedia, type ProbeResult } from "./probe";
import { runCommand } from "../lib/process";

export interface RenderResult {
  runDirectory: string;
  clips: Array<{ id: string; videoPath: string; captionPath: string; durationSeconds: number; elapsedMs: number; probe: ProbeResult }>;
  elapsedMs: number;
  estimatedCostUsd: number;
}

export interface RenderOptions {
  runCommand?: typeof runCommand;
  now?: () => number;
  projectDirectory?: string;
  fontFile?: string;
}

const SUBTITLE_FONT = "Nirmala UI";
const SUBTITLE_FONT_DIR = "C:/Windows/Fonts";

export async function runRendering(
  sourceFile: string,
  editIrFile: string,
  transcriptFile: string,
  outputDirectory: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const commandRunner = options.runCommand ?? runCommand;
  const now = options.now ?? Date.now;
  const projectDirectory = resolve(options.projectDirectory ?? process.cwd());
  const sourcePath = resolve(sourceFile);
  const irPath = resolve(editIrFile);
  const transcriptPath = resolve(transcriptFile);
  const output = resolve(outputDirectory);
  if (isWithin(projectDirectory, output)) throw new Error("Render output must be outside the project directory");
  if ([sourcePath, irPath, transcriptPath].some((input) => output === input || isWithin(output, input))) {
    throw new Error("Render output cannot contain or replace an input file");
  }
  await access(sourcePath);
  await access(irPath);
  await access(transcriptPath);
  const ir: EditIr = editIrSchema.parse(JSON.parse(await readFile(irPath, "utf8")));
  validateRenderPlan(ir);
  const transcript: TranscriptDocument = transcriptSchema.parse(JSON.parse(await readFile(transcriptPath, "utf8")));
  const sourceHash = await sha256(sourcePath);
  if (sourceHash !== ir.source.sha256 || sourceHash !== transcript.source.sha256) {
    throw new Error("Source video hash does not match the Edit IR and transcript; refusing to render mismatched media");
  }
  if (basename(sourcePath) !== ir.source.file || basename(sourcePath) !== transcript.source.fileName) {
    throw new Error("Source video filename does not match the Edit IR and transcript");
  }
  const sourceProbe = await probeMedia(sourcePath);
  const sourceDuration = mediaDurationSeconds(sourceProbe);
  if (Math.abs(sourceDuration - ir.source.duration_s) > 0.1 || Math.abs(sourceDuration - transcript.source.durationSeconds) > 0.1) {
    throw new Error("Source video duration does not match the Edit IR and transcript");
  }
  if (!sourceProbe.streams.some((stream) => stream.codec_type === "video")) throw new Error("Source video has no video stream");
  if (!sourceProbe.streams.some((stream) => stream.codec_type === "audio")) throw new Error("Source video has no audio stream; M4 requires AAC audio in exports");
  const fontFile = options.fontFile ?? "C:/Windows/Fonts/Nirmala.ttc";
  await access(fontFile);
  try { await access(output); throw new Error(`Output directory already exists: ${output}`); }
  catch (error) { if (error instanceof Error && error.message.startsWith("Output directory already exists:")) throw error; }
  await mkdir(join(output, "clips"), { recursive: true });
  const commandsPath = join(output, "ffmpeg-commands.jsonl");
  const started = now();
  const rendered: RenderResult["clips"] = [];
  const logs: Array<Record<string, unknown>> = [];
  const persist = async (failure?: unknown) => writeFile(join(output, failure ? "failure.json" : "render.json"), `${JSON.stringify({
    schemaVersion: "vclip-render/0.1",
    status: failure ? "failed" : "completed",
    source: { path: sourcePath, sha256: sourceHash, durationSeconds: sourceDuration },
    editIr: basename(irPath), transcript: basename(transcriptPath),
    settings: { width: 1080, height: 1920, aspect: "9:16", crop: "center", videoCodec: "h264", audioCodec: "aac", fontFamily: SUBTITLE_FONT, fontFile, deterministic: true },
    elapsedMs: now() - started,
    estimatedCostUsd: 0,
    clips: rendered.map(({ id, videoPath, captionPath, durationSeconds, elapsedMs, probe }) => ({ id, videoPath, captionPath, durationSeconds, elapsedMs, probe })),
    failure: failure instanceof Error ? failure.message : failure,
  }, null, 2)}\n`, { encoding: "utf8" });

  try {
    for (const clip of ir.clips) {
      const clipRecord = finalClipSchema.parse(clip);
      const duration = clipRecord.end_s - clipRecord.start_s;
      const relevantWords = wordsInRange(transcript.words, clipRecord.start_s, clipRecord.end_s);
      const captionPath = join(output, "clips", `${safeName(clipRecord.id)}.ass`);
      await writeFile(captionPath, createAssCaptions(relevantWords, clipRecord.start_s, duration), { encoding: "utf8" });
      const videoPath = join(output, "clips", `${safeName(clipRecord.id)}.mp4`);
      const args = buildFfmpegArgs(sourcePath, videoPath, captionPath, clipRecord.start_s, duration, SUBTITLE_FONT_DIR);
      const record = { clipId: clipRecord.id, command: "ffmpeg", args, startedAt: new Date().toISOString(), status: "running" };
      await appendFile(commandsPath, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
      const clipStarted = now();
      try {
        const result = await commandRunner("ffmpeg", args, { timeoutMs: 30 * 60 * 1000 });
        logs.push({ clipId: clipRecord.id, stdout: result.stdout, stderr: result.stderr });
        const probe = await probeMedia(videoPath);
        verifyRenderedOutput(probe, duration);
        const elapsedMs = now() - clipStarted;
        rendered.push({ id: clipRecord.id, videoPath, captionPath, durationSeconds: mediaDurationSeconds(probe), elapsedMs, probe });
        await appendFile(commandsPath, `${JSON.stringify({ clipId: clipRecord.id, status: "succeeded", elapsedMs, probe })}\n`, { encoding: "utf8" });
      } catch (error) {
        await appendFile(commandsPath, `${JSON.stringify({ clipId: clipRecord.id, status: "failed", elapsedMs: now() - clipStarted, error: error instanceof Error ? error.message : String(error) })}\n`, { encoding: "utf8" });
        await writeFile(join(output, "ffmpeg-partial.log"), logs.map((item) => JSON.stringify(item)).join("\n") + `\n${error instanceof Error ? error.message : String(error)}\n`, { encoding: "utf8" });
        throw error;
      }
    }
    await persist();
    await writeFile(join(output, "cost.json"), `${JSON.stringify({ currency: "USD", estimatedTotalUsd: 0, localProcessing: { elapsedMs: now() - started, note: "FFmpeg work is local and uses no paid provider or service; compute and electricity are not monetarily estimated." }, clips: rendered.map(({ id, elapsedMs, durationSeconds }) => ({ id, elapsedMs, durationSeconds })) }, null, 2)}\n`, { encoding: "utf8" });
    return { runDirectory: output, clips: rendered, elapsedMs: now() - started, estimatedCostUsd: 0 };
  } catch (error) {
    await writeFile(join(output, "ffmpeg-partial.log"), `${logs.map((item) => JSON.stringify(item)).join("\n")}\n${error instanceof Error ? error.message : String(error)}\n`, { encoding: "utf8" }).catch(() => undefined);
    await persist(error).catch(() => undefined);
    throw error;
  }
}

export function createAssCaptions(words: TranscriptWord[], clipStart: number, duration: number): string {
  const cues: Array<{ start: number; end: number; text: string }> = [];
  let current: TranscriptWord[] = [];
  const flush = () => {
    if (!current.length) return;
    const first = current[0]!;
    const last = current[current.length - 1]!;
    cues.push({ start: Math.max(0, first.startSeconds - clipStart), end: Math.min(duration, last.endSeconds - clipStart), text: current.map((word) => word.text).join(" ") });
    current = [];
  };
  for (const word of words) {
    current.push(word);
    const text = word.text;
    const elapsed = current[current.length - 1]!.endSeconds - current[0]!.startSeconds;
    if (current.length >= 5 || elapsed >= 2.4 || /[.!?।]$/u.test(text)) flush();
  }
  flush();
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${SUBTITLE_FONT},58,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,1,4,1,2,90,90,230,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const body = cues.filter((cue) => cue.end > cue.start).map((cue) => `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${escapeAss(cue.text)}`).join("\n");
  return `${header}${body}${body ? "\n" : ""}`;
}

export function buildFfmpegArgs(source: string, output: string, subtitles: string, start: number, duration: number, fontsDir = SUBTITLE_FONT_DIR): string[] {
  const subtitleFilter = `subtitles=filename='${escapeFilterPath(subtitles)}':fontsdir='${escapeFilterPath(fontsDir)}':force_style='FontName=${SUBTITLE_FONT},FontSize=58,Bold=1,Outline=4,Shadow=1,MarginV=230'`;
  // Crop at source resolution first, then force square pixels for exact 9:16 display.
  const videoFilter = [
    "crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)':x=(iw-ow)/2:y=(ih-oh)/2",
    "scale=1080:1920",
    "setsar=1",
    subtitleFilter,
  ].join(",");
  return [
    "-hide_banner", "-loglevel", "warning", "-nostdin", "-y", "-ss", start.toFixed(3), "-i", source, "-t", duration.toFixed(3),
    "-map", "0:v:0", "-map", "0:a:0?", "-vf", videoFilter,
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-threads", "1",
    "-x264-params", "threads=1:scenecut=0", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact", "-movflags", "+faststart", output,
  ];
}

export function verifyRenderedOutput(probe: ProbeResult, expectedDuration: number, toleranceSeconds = 0.35): void {
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  if (video?.codec_name !== "h264") throw new Error(`Rendered video must use H.264; got ${video?.codec_name ?? "no video stream"}`);
  if (video.width !== 1080 || video.height !== 1920) throw new Error(`Rendered video must be 1080x1920; got ${video.width ?? "?"}x${video.height ?? "?"}`);
  if (video.sample_aspect_ratio !== "1:1") throw new Error(`Rendered video must use square pixels for exact 9:16 display; got ${video.sample_aspect_ratio ?? "unknown"}`);
  if (audio?.codec_name !== "aac") throw new Error(`Rendered audio must use AAC; got ${audio?.codec_name ?? "no audio stream"}`);
  const actualDuration = mediaDurationSeconds(probe);
  if (Math.abs(actualDuration - expectedDuration) > toleranceSeconds) throw new Error(`Rendered duration ${actualDuration.toFixed(3)}s differs from expected ${expectedDuration.toFixed(3)}s by more than ${toleranceSeconds}s`);
}

export function validateRenderPlan(ir: EditIr): void {
  let previousEnd = -Infinity;
  for (const clip of ir.clips) {
    const duration = clip.end_s - clip.start_s;
    if (clip.start_s < 0 || clip.end_s <= clip.start_s || clip.end_s > ir.source.duration_s) {
      throw new Error("Clip " + clip.id + " has timestamps outside the source video");
    }
    if (duration < 15 || duration > Math.min(90, clip.output.max_duration_s)) {
      throw new Error("Clip " + clip.id + " duration must be between 15 and " + Math.min(90, clip.output.max_duration_s) + " seconds");
    }
    if (clip.start_s < previousEnd) throw new Error("Clip " + clip.id + " overlaps the previous clip");
    previousEnd = clip.end_s;
  }
}

function wordsInRange(words: TranscriptWord[], start: number, end: number): TranscriptWord[] {
  return words.filter((word) => word.endSeconds > start && word.startSeconds < end).map((word) => ({
    ...word,
    startSeconds: Math.max(start, word.startSeconds),
    endSeconds: Math.min(end, word.endSeconds),
  }));
}

function assTime(seconds: number): string {
  const centiseconds = Math.max(0, Math.floor(seconds * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const secs = Math.floor((centiseconds % 6000) / 100);
  const cs = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeAss(text: string): string { return text.replaceAll("\\", "\\\\").replaceAll("{", "\\{").replaceAll("}", "\\}").replaceAll("\n", "\\N"); }
function escapeFilterPath(path: string): string { return path.replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "\\'").replaceAll(",", "\\,").replaceAll("[", "\\[").replaceAll("]", "\\]"); }
function safeName(value: string): string { const safe = value.replace(/[^a-zA-Z0-9_-]/g, "_"); if (!safe) throw new Error("Clip ID cannot produce a safe output filename"); return safe; }
function isWithin(parent: string, child: string): boolean { const path = relative(parent, child); return path === "" || (path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path)); }
async function sha256(path: string): Promise<string> { const hash = createHash("sha256"); await pipeline(createReadStream(path), hash); return hash.digest("hex"); }
