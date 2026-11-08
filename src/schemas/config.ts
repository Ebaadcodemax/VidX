import { z } from "zod";

const rateSchema = z.object({
  inputUsdPerMillionTokens: z.number().nonnegative().optional(),
  outputUsdPerMillionTokens: z.number().nonnegative().optional(),
  audioUsdPerMinute: z.number().nonnegative().optional(),
}).strict();

export const configSchema = z.object({
  runtime: z.object({
    maxRunCostUsd: z.number().positive().default(0.05),
    defaultOutputDirectory: z.string().min(1).default("runs"),
  }).strict().default({ maxRunCostUsd: 0.05, defaultOutputDirectory: "runs" }),
  pricing: z.record(z.string(), z.record(z.string(), rateSchema)).default({}),
  requiredEnv: z.array(z.string().min(1)).default([]),
}).strict();

export type AppConfig = z.infer<typeof configSchema>;
export type ModelRate = z.infer<typeof rateSchema>;
