import { z } from "zod";
import { runCommand } from "../lib/process";

const ffprobeOutputSchema = z.object({
  format: z.object({
    format_name: z.string().optional(),
    duration: z.string().optional(),
    size: z.string().optional(),
    bit_rate: z.string().optional(),
  }).passthrough(),
  streams: z.array(z.object({
    index: z.number().int(),
    codec_type: z.string(),
    codec_name: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    sample_aspect_ratio: z.string().optional(),
    sample_rate: z.string().optional(),
    channels: z.number().optional(),
    avg_frame_rate: z.string().optional(),
  }).passthrough()),
}).passthrough();

export type ProbeResult = z.infer<typeof ffprobeOutputSchema>;

export async function probeMedia(inputPath: string): Promise<ProbeResult> {
  const { stdout } = await runCommand("ffprobe", [
    "-v", "error",
    "-show_format",
    "-show_streams",
    "-of", "json",
    inputPath,
  ]);

  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error("ffprobe returned invalid JSON");
  }
  const result = ffprobeOutputSchema.safeParse(json);
  if (!result.success) throw new Error(`ffprobe output did not match expected fields: ${result.error.message}`);
  return result.data;
}

export function mediaDurationSeconds(probe: ProbeResult): number {
  const raw = Number(probe.format.duration);
  if (!Number.isFinite(raw) || raw <= 0) throw new Error("Media duration is missing or invalid");
  return raw;
}
