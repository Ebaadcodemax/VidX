import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/lib/config";
import { runBatch } from "../src/pipeline/batch";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("batch processing", () => {
  it("isolates failures and continues sequentially through supported videos", async () => {
    const root = await mkdtemp(join(tmpdir(), "vclip-batch-test-"));
    temporary.push(root);
    const source = join(root, "input");
    const output = join(root, "batch");
    await mkdir(source);
    await writeFile(join(source, "01-good.mp4"), "one");
    await writeFile(join(source, "02-bad.mov"), "two");
    await writeFile(join(source, "03-good.webm"), "three");
    await writeFile(join(source, "ignore.txt"), "skip");
    const order: string[] = [];
    const report = await runBatch(source, output, await loadConfig(), {
      processor: async (file, runDirectory) => {
        order.push(file);
        if (file.includes("02-bad")) throw new Error("Stage 'media probing' failed for 02-bad.mov: invalid media");
        await mkdir(runDirectory);
        return { runDirectory, manifestPath: "", audioPath: "", durationSeconds: 1, resumed: false };
      },
    });
    expect(report.items.map((item) => item.status)).toEqual(["succeeded", "failed", "succeeded"]);
    expect(report.items[1]?.stage).toBe("media probing");
    expect(order).toHaveLength(3);
    expect(new Set(report.items.map((item) => item.runDirectory)).size).toBe(3);
    expect(JSON.parse(await readFile(join(output, "batch.json"), "utf8")).items).toHaveLength(3);
  });

  it("refuses a missing or malformed batch checkpoint instead of pretending to resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "vclip-batch-resume-"));
    temporary.push(root);
    const source = join(root, "input");
    const output = join(root, "batch");
    await mkdir(source);
    await writeFile(join(source, "one.mp4"), "video");
    await mkdir(output);
    await expect(runBatch(source, output, await loadConfig(), { resume: true })).rejects.toThrow("Cannot resume batch");
  });
});
