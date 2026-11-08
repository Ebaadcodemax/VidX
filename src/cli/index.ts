import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "../lib/config";
import { runCommand } from "../lib/process";
import { runLocalPipeline } from "../pipeline/run";
import { costRecordSchema } from "../schemas/manifest";

const program = new Command();
program
  .name("vclip")
  .description("Local AI-assisted clip production pipeline")
  .version("0.1.0");

program.command("init")
  .description("Check local tools and configuration")
  .action(async () => {
    const config = await loadConfig();
    const checks = await Promise.all([
      checkCommand("node", ["--version"]),
      checkCommand("ffmpeg", ["-version"]),
      checkCommand("ffprobe", ["-version"]),
    ]);
    checks.forEach(({ name, value, error }) => {
      console.log(error ? `MISSING ${name}: ${error}` : `OK ${name}: ${value}`);
    });
    const missing = config.requiredEnv.filter((name) => !process.env[name]);
    if (missing.length) console.log(`MISSING environment variables: ${missing.join(", ")}`);
    else console.log(config.requiredEnv.length ? "OK required environment variables" : "OK no provider API keys required for the local pipeline");
    if (checks.some((check) => check.error) || missing.length) process.exitCode = 1;
  });

program.command("run")
  .description("Probe one local media file and extract normalized audio")
  .argument("<media-file>", "Path to a creator-provided local media file")
  .option("--out <directory>", "New run directory; defaults to config.yaml setting")
  .action(async (mediaFile: string, options: { out?: string }) => {
    const config = await loadConfig();
    const result = await runLocalPipeline(mediaFile, options.out, config);
    console.log(`Run complete: ${result.runDirectory}`);
    console.log(`Duration: ${result.durationSeconds.toFixed(2)} seconds`);
    console.log(`Audio: ${result.audioPath}`);
    console.log(`Manifest: ${result.manifestPath}`);
    console.log("Estimated provider cost: $0.000000 (no provider calls in this milestone)");
  });

program.command("cost")
  .description("Show the cost record for a completed local run")
  .argument("<run-directory>")
  .action(async (runDirectory: string) => {
    const costPath = join(resolve(runDirectory), "cost.json");
    const parsed: unknown = JSON.parse(await readFile(costPath, "utf8"));
    console.log(JSON.stringify(costRecordSchema.parse(parsed), null, 2));
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : "Unexpected failure"}`);
  process.exitCode = 1;
});

async function checkCommand(name: string, args: string[]): Promise<{ name: string; value?: string; error?: string }> {
  try {
    const { stdout } = await runCommand(name, args, { timeoutMs: 10_000 });
    const firstLine = stdout.split(/\r?\n/).find(Boolean) ?? "available";
    return { name, value: firstLine.trim() };
  } catch (error) {
    return { name, error: error instanceof Error ? error.message : "not available" };
  }
}
