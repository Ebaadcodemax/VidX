import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import type { AppConfig } from "../schemas/config";
import { runLocalPipeline, type RunSummary } from "./run";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm"]);

export interface BatchItem {
  sourceFile: string;
  status: "pending" | "succeeded" | "failed";
  stage: string;
  runDirectory: string;
  error?: string;
  resumed?: boolean;
}

export interface BatchReport {
  schemaVersion: "vclip-batch/0.1";
  batchId: string;
  startedAt: string;
  completedAt: string;
  sourceFolder: string;
  runDirectory: string;
  items: BatchItem[];
}

type Processor = (source: string, runDirectory: string, config: AppConfig, resume: boolean) => Promise<RunSummary>;

export async function listSupportedVideos(folder: string): Promise<string[]> {
  const root = resolve(folder);
  const entries = await readdir(root, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) found.push(...await listSupportedVideos(full));
    else if (entry.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) found.push(full);
  }
  return found.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
}

export async function runBatch(
  sourceFolder: string,
  outputDirectory: string,
  config: AppConfig,
  options: { resume?: boolean; processor?: Processor } = {},
): Promise<BatchReport> {
  const sourceRoot = resolve(sourceFolder);
  const reportDirectory = resolve(outputDirectory);
  const inputs = await listSupportedVideos(sourceRoot);
  if (!inputs.length) throw new Error(`No supported videos found in ${sourceRoot}. Supported extensions: MP4, MOV, WebM.`);

  const isResume = options.resume === true;
  if (isResume) {
    try { await access(reportDirectory); }
    catch { throw new Error(`Cannot resume; batch directory does not exist: ${reportDirectory}`); }
  } else {
    await mkdir(reportDirectory, { recursive: false });
  }

  const reportPath = join(reportDirectory, "batch.json");
  const prior = isResume ? await readPriorBatch(reportPath) : undefined;
  const priorBySource = new Map(prior?.items.map((item) => [resolve(item.sourceFile), item]));
  const startedAt = prior?.startedAt ?? new Date().toISOString();
  const items: BatchItem[] = inputs.map((input) => ({
    sourceFile: input,
    status: "pending",
    stage: "queued",
    runDirectory: priorBySource.get(input)?.runDirectory || join(reportDirectory, `${safeStem(input)}_${randomUUID().slice(0, 8)}`),
    ...(priorBySource.get(input)?.error ? { error: priorBySource.get(input)!.error } : {}),
  }));
  await saveReport(reportPath, {
    schemaVersion: "vclip-batch/0.1",
    batchId: prior?.batchId ?? basename(reportDirectory),
    startedAt,
    completedAt: prior?.completedAt ?? startedAt,
    sourceFolder: sourceRoot,
    runDirectory: reportDirectory,
    items,
  });
  const processVideo = options.processor ?? defaultProcessor;

  for (const [index, input] of inputs.entries()) {
    const item = items[index]!;
    const previous = priorBySource.get(input);
    const runDirectory = item.runDirectory;
    const resumeRun = isResume && Boolean(previous) && await exists(runDirectory);
    try {
      await processVideo(input, runDirectory, config, resumeRun);
      Object.assign(item, { status: "succeeded", stage: "probe and audio extraction", error: undefined, resumed: resumeRun });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected processing failure";
      const stageMatch = /^Stage '([^']+)' failed/.exec(message);
      Object.assign(item, {
        status: "failed",
        stage: stageMatch?.[1] ?? (resumeRun ? "resume validation" : "pipeline"),
        runDirectory,
        error: message,
        resumed: resumeRun,
      });
    }
    await saveReport(reportPath, {
      schemaVersion: "vclip-batch/0.1",
      batchId: basename(reportDirectory),
      startedAt,
      completedAt: new Date().toISOString(),
      sourceFolder: sourceRoot,
      runDirectory: reportDirectory,
      items,
    });
  }

  const report: BatchReport = {
    schemaVersion: "vclip-batch/0.1",
    batchId: prior?.batchId ?? basename(reportDirectory),
    startedAt,
    completedAt: new Date().toISOString(),
    sourceFolder: sourceRoot,
    runDirectory: reportDirectory,
    items,
  };
  await saveReport(reportPath, report);
  return report;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function defaultProcessor(source: string, runDirectory: string, config: AppConfig, resume: boolean): Promise<RunSummary> {
  return runLocalPipeline(source, runDirectory, config, { resume });
}

async function readPriorBatch(path: string): Promise<BatchReport> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error();
    const report = parsed as Partial<BatchReport>;
    if (report.schemaVersion !== "vclip-batch/0.1" || !Array.isArray(report.items) || typeof report.runDirectory !== "string" || resolve(report.runDirectory) !== resolve(path, "..")) throw new Error();
    const root = resolve(path, "..");
    for (const item of report.items) {
      if (!item || typeof item.sourceFile !== "string" || typeof item.runDirectory !== "string" || !["pending", "succeeded", "failed"].includes(item.status) || typeof item.stage !== "string") throw new Error();
      const rel = relative(root, resolve(item.runDirectory));
      if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || resolve(item.runDirectory) === root) throw new Error();
    }
    return report as BatchReport;
  } catch {
    throw new Error(`Cannot resume batch: ${path} is missing or invalid. Nothing was reused.`);
  }
}

async function saveReport(path: string, report: BatchReport): Promise<void> {
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function safeStem(path: string): string {
  return basename(path).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 48) || "video";
}
