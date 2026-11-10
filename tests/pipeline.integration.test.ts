import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/lib/config";
import { runLocalPipeline } from "../src/pipeline/run";
import { manifestSchema, costRecordSchema } from "../src/schemas/manifest";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local M1 media pipeline", () => {
  it("probes a synthetic fixture, extracts WAV, and writes valid manifest and cost records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vclip-test-"));
    tempDirs.push(directory);
    const inputPath = join(directory, "fixture.mp4");
    const outputPath = join(directory, "run");
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
      "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", inputPath,
    ], { timeout: 30_000 });

    const result = await runLocalPipeline(inputPath, outputPath, await loadConfig());
    const manifest = manifestSchema.parse(JSON.parse(await readFile(result.manifestPath, "utf8")));
    const cost = costRecordSchema.parse(JSON.parse(await readFile(join(outputPath, "cost.json"), "utf8")));

    expect(manifest.input.fileName).toBe("fixture.mp4");
    expect(manifest.input.durationSeconds).toBeGreaterThan(1.9);
    expect(manifest.input.sha256).toHaveLength(64);
    expect(cost.estimatedTotalUsd).toBe(0);
    expect((await stat(result.audioPath)).size).toBeGreaterThan(1_000);
  });

  it("does not overwrite an existing run directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vclip-test-"));
    tempDirs.push(directory);
    const inputPath = join(directory, "placeholder.mp4");
    const outputPath = join(directory, "already-exists");
    await writeFile(inputPath, "not a media file");
    await mkdir(outputPath);
    await expect(runLocalPipeline(inputPath, outputPath, await loadConfig())).rejects.toThrow("already exists");
  });

  it("resumes a complete run only after validating source and audio hashes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vclip-resume-test-"));
    tempDirs.push(directory);
    const inputPath = join(directory, "fixture.mp4");
    const outputPath = join(directory, "run");
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
      "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", inputPath,
    ], { timeout: 30_000 });
    const config = await loadConfig();
    await runLocalPipeline(inputPath, outputPath, config);
    const resumed = await runLocalPipeline(inputPath, outputPath, config, { resume: true });
    expect(resumed.resumed).toBe(true);
    await writeFile(resumed.audioPath, "corrupt");
    await expect(runLocalPipeline(inputPath, outputPath, config, { resume: true })).rejects.toThrow("audio.wav is missing or has changed");
  });

  it("refuses to resume artifacts against a changed source file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vclip-resume-hash-test-"));
    tempDirs.push(directory);
    const inputPath = join(directory, "fixture.mp4");
    const outputPath = join(directory, "run");
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
      "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", inputPath,
    ], { timeout: 30_000 });
    const config = await loadConfig();
    await runLocalPipeline(inputPath, outputPath, config);
    await writeFile(inputPath, "changed source");
    await expect(runLocalPipeline(inputPath, outputPath, config, { resume: true })).rejects.toThrow("source file hash differs");
  });
});
