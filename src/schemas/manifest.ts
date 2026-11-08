import { z } from "zod";

export const manifestSchema = z.object({
  schemaVersion: z.literal("vclip-manifest/0.1"),
  runId: z.string().min(1),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  input: z.object({
    fileName: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
    durationSeconds: z.number().positive(),
    formatName: z.string().nullable(),
    streams: z.array(z.record(z.string(), z.unknown())),
  }).strict(),
  outputs: z.object({ extractedAudio: z.literal("audio.wav"), format: z.string() }).strict(),
  versions: z.object({ node: z.string(), pipeline: z.string() }).strict(),
  stages: z.record(z.string(), z.number().nonnegative()),
  providers: z.array(z.unknown()),
}).strict();

export const costRecordSchema = z.object({
  currency: z.literal("USD"),
  estimatedTotalUsd: z.number().nonnegative(),
  providerCalls: z.array(z.object({
    provider: z.string(),
    model: z.string(),
    usage: z.record(z.string(), z.number().nonnegative()),
    estimatedCostUsd: z.number().nonnegative(),
  }).strict()),
  localProcessing: z.object({
    sourceDurationSeconds: z.number().nonnegative(),
    audioExtractMs: z.number().nonnegative(),
    note: z.string(),
  }).strict(),
}).strict();
