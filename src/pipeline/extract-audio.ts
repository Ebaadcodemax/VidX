import { access } from "node:fs/promises";
import { runCommand } from "../lib/process";

export async function extractAudio(inputPath: string, outputPath: string): Promise<void> {
  await runCommand("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
    "-i", inputPath,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    outputPath,
  ], { timeoutMs: 15 * 60 * 1000 });
  await access(outputPath);
}
