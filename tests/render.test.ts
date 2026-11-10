import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAssCaptions, runRendering, validateRenderPlan, verifyRenderedOutput } from "../src/pipeline/render";
import type { ProbeResult } from "../src/pipeline/probe";
import type { TranscriptDocument } from "../src/schemas/transcript";
import type { EditIr } from "../src/schemas/edit-ir";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const devanagariFont = "C:/Windows/Fonts/Nirmala.ttc";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("M4 rendering", () => {
  it("generates timed ASS captions with Latin and Devanagari text", () => {
    const ass = createAssCaptions([
      { text: "Hello", startSeconds: 1, endSeconds: 1.4, speakerId: null },
      { text: "दुनिया।", startSeconds: 1.4, endSeconds: 2, speakerId: null },
    ], 1, 3);
    expect(ass).toContain("Hello दुनिया।");
    expect(ass).toContain("0:00:00.00,0:00:01.00");
    expect(ass).toContain("Nirmala UI");
  });

  it("rejects the wrong codecs, frame size, missing audio, and out-of-tolerance duration", () => {
    const valid = {
      format: { duration: "4.00" },
      streams: [
        { index: 0, codec_type: "video", codec_name: "h264", width: 1080, height: 1920, sample_aspect_ratio: "1:1" },
        { index: 1, codec_type: "audio", codec_name: "aac" },
      ],
    } as ProbeResult;
    expect(() => verifyRenderedOutput(valid, 4)).not.toThrow();
    expect(() => verifyRenderedOutput({ ...valid, streams: [{ ...valid.streams[0]!, sample_aspect_ratio: "2:1" }, valid.streams[1]!] }, 4)).toThrow("square pixels");
    expect(() => verifyRenderedOutput({ ...valid, streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 720, height: 1280 }, valid.streams[1]!] }, 4)).toThrow("1080x1920");
    expect(() => verifyRenderedOutput({ ...valid, streams: [valid.streams[0]!, { index: 1, codec_type: "audio", codec_name: "mp3" }] }, 4)).toThrow("AAC");
    expect(() => verifyRenderedOutput({ ...valid, streams: [valid.streams[0]!] }, 4)).toThrow("AAC");
    expect(() => verifyRenderedOutput({ ...valid, format: { duration: "4.5" } }, 4)).toThrow("duration");
  });

  it("rejects invalid bounds, durations, and overlapping clips before rendering", () => {
    const base: EditIr = {
      version: "edit-ir/0.1", source: { file: "x.mp4", sha256: "a".repeat(64), duration_s: 40 }, language: "en",
      clips: [{
        id: "a", start_s: 0, end_s: 15, title: "a", hook_text: "a", payoff: "a", reason: "a",
        scores: { hook: 1, standalone: 1, payoff: 1, emotion: 1 }, needs_context_line: false, context_line: null,
        speakers: [], captions: { style: "default", language: "en" }, output: { aspect: "9:16", max_duration_s: 90 },
        critic: { verdict: "keep", standalone: true, hook_strength: 5, payoff: true, reason: "a" },
      }],
    };
    expect(() => validateRenderPlan(base)).not.toThrow();
    expect(() => validateRenderPlan({ ...base, clips: [{ ...base.clips[0]!, end_s: 41 }] })).toThrow("timestamps");
    expect(() => validateRenderPlan({ ...base, clips: [{ ...base.clips[0]!, end_s: 14 }] })).toThrow("duration");
    expect(() => validateRenderPlan({ ...base, clips: [base.clips[0]!, { ...base.clips[0]!, id: "b", start_s: 10, end_s: 25 }] })).toThrow("overlaps");
  });

  it("renders validated Edit IR with centered 9:16 crop, both scripts, and deterministic output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vclip-render-test-"));
    tempDirs.push(directory);
    const source = join(directory, "fixture.mp4");
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24:duration=20",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=20",
      "-shortest", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", source,
    ], { timeout: 30_000 });
    const hash = await fileHash(source);
    const transcript: TranscriptDocument = {
      schemaVersion: "vclip-transcript/0.1",
      provider: { id: "faster-whisper", model: "test", version: "test" },
      source: { fileName: "fixture.mp4", sha256: hash, durationSeconds: 20 },
      language: { code: "hi", probability: 1 },
      speakerLabels: "unavailable",
      transcriptText: "Hello दुनिया।",
      segments: [{ startSeconds: 0.1, endSeconds: 2, text: "Hello दुनिया।", speakerId: null, wordStartIndex: 0, wordEndIndex: 2 }],
      words: [
        { text: "Hello", startSeconds: 0.1, endSeconds: 0.8, speakerId: null },
        { text: "दुनिया।", startSeconds: 0.9, endSeconds: 1.6, speakerId: null },
      ],
      timing: { startedAt: new Date(0).toISOString(), elapsedMs: 0 },
      usage: { audioSeconds: 20, inputTokens: null, outputTokens: null, estimatedCostUsd: 0, costBasis: "test" },
      cleanupWarnings: [],
    };
    const editIr: EditIr = {
      version: "edit-ir/0.1",
      source: { file: "fixture.mp4", sha256: hash, duration_s: 20 },
      language: "hi-en",
      clips: [{
        id: "c1", start_s: 0, end_s: 15, title: "Hello", hook_text: "Hello", payoff: "world", reason: "test",
        scores: { hook: 1, standalone: 1, payoff: 1, emotion: 0 }, needs_context_line: false, context_line: null,
        speakers: [], captions: { style: "default", language: "hi-en" }, output: { aspect: "9:16", max_duration_s: 90 },
        critic: { verdict: "keep", standalone: true, hook_strength: 5, payoff: true, reason: "Clear standalone line." },
      }],
    };
    const irPath = join(directory, "edit_ir.json");
    const transcriptPath = join(directory, "transcript.json");
    await writeFile(irPath, JSON.stringify(editIr));
    await writeFile(transcriptPath, JSON.stringify(transcript));
    const firstOutput = join(directory, "first");
    const secondOutput = join(directory, "second");
    const first = await runRendering(source, irPath, transcriptPath, firstOutput, { fontFile: devanagariFont });
    const second = await runRendering(source, irPath, transcriptPath, secondOutput, { fontFile: devanagariFont });
    expect(first.clips).toHaveLength(1);
    expect(first.clips[0]!.probe.streams.find((stream) => stream.codec_type === "video")).toMatchObject({ codec_name: "h264", width: 1080, height: 1920 });
    expect(first.clips[0]!.probe.streams.find((stream) => stream.codec_type === "audio")?.codec_name).toBe("aac");
    expect((await readFile(first.clips[0]!.captionPath, "utf8"))).toContain("Hello दुनिया।");
    expect(await fileHash(first.clips[0]!.videoPath)).toBe(await fileHash(second.clips[0]!.videoPath));
    expect((await readFile(join(firstOutput, "ffmpeg-commands.jsonl"), "utf8")).match(/"status":"succeeded"/g)).toHaveLength(1);
    expect(JSON.parse(await readFile(join(firstOutput, "cost.json"), "utf8")).estimatedTotalUsd).toBe(0);
  }, 120_000);
});

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
