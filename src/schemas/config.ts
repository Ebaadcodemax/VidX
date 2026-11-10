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
  transcription: z.object({
    providers: z.array(z.enum(["faster-whisper", "gemini"])).default(["faster-whisper", "gemini"]),
    local: z.object({
      pythonPath: z.string().min(1).default(".venv-asr/Scripts/python.exe"),
      downloadDirectory: z.string().min(1).default("local-models"),
      model: z.enum(["tiny", "base", "small", "medium", "large-v3", "turbo"]).default("small"),
      device: z.enum(["cpu", "cuda"]).default("cpu"),
      computeType: z.enum(["int8", "int8_float16", "float16", "float32"]).default("int8"),
      cpuThreads: z.number().int().positive().max(64).default(8),
    }).strict().default({
      pythonPath: ".venv-asr/Scripts/python.exe", downloadDirectory: "local-models", model: "small", device: "cpu", computeType: "int8", cpuThreads: 8,
    }),
    gemini: z.object({
      model: z.string().min(1).default("gemini-3.5-transcribe"),
      apiKeyEnv: z.string().min(1).default("GEMINI_API_KEY"),
      creatorConsentEnv: z.string().min(1).default("GEMINI_CREATOR_CONSENT"),
      unpaidDataUseAckEnv: z.string().min(1).default("GEMINI_UNPAID_DATA_USE_ACK"),
      freeTierOnlyEnv: z.string().min(1).default("GEMINI_FREE_TIER_ONLY"),
      maxTimestampMinutes: z.number().positive().max(30).default(30),
    }).strict().default({
      model: "gemini-3.5-transcribe", apiKeyEnv: "GEMINI_API_KEY", creatorConsentEnv: "GEMINI_CREATOR_CONSENT",
      unpaidDataUseAckEnv: "GEMINI_UNPAID_DATA_USE_ACK", freeTierOnlyEnv: "GEMINI_FREE_TIER_ONLY", maxTimestampMinutes: 30,
    }),
  }).strict().default({
    providers: ["faster-whisper", "gemini"],
    local: { pythonPath: ".venv-asr/Scripts/python.exe", downloadDirectory: "local-models", model: "small", device: "cpu", computeType: "int8", cpuThreads: 8 },
    gemini: { model: "gemini-3.5-transcribe", apiKeyEnv: "GEMINI_API_KEY", creatorConsentEnv: "GEMINI_CREATOR_CONSENT", unpaidDataUseAckEnv: "GEMINI_UNPAID_DATA_USE_ACK", freeTierOnlyEnv: "GEMINI_FREE_TIER_ONLY", maxTimestampMinutes: 30 },
  }),
  reasoner: z.object({
    provider: z.literal("gemini").default("gemini"),
    model: z.string().min(1).default("gemini-3.8-flash"),
    apiKeyEnv: z.string().min(1).default("GEMINI_API_KEY"),
    creatorConsentEnv: z.string().min(1).default("GEMINI_CREATOR_CONSENT"),
    unpaidDataUseAckEnv: z.string().min(1).default("GEMINI_UNPAID_DATA_USE_ACK"),
    freeTierOnlyEnv: z.string().min(1).default("GEMINI_FREE_TIER_ONLY"),
    maxOutputTokens: z.number().int().positive().max(8192).default(2048),
    timeoutMs: z.number().int().positive().max(300000).default(120000),
    thinkingLevel: z.enum(["low", "medium", "high"]).default("low"),
    maxRetries: z.number().int().min(0).max(5).default(3),
    retryBaseDelayMs: z.number().int().nonnegative().max(10000).default(1000),
    retryMaxDelayMs: z.number().int().nonnegative().max(30000).default(8000),
    maxClips: z.number().int().positive().max(20).default(8),
    minClipSeconds: z.number().positive().default(15),
    maxClipSeconds: z.number().positive().max(90).default(90),
    endPaddingSeconds: z.number().nonnegative().max(1).default(0.3),
  }).strict().default({
    provider: "gemini", model: "gemini-3.8-flash", apiKeyEnv: "GEMINI_API_KEY",
    creatorConsentEnv: "GEMINI_CREATOR_CONSENT", unpaidDataUseAckEnv: "GEMINI_UNPAID_DATA_USE_ACK",
    freeTierOnlyEnv: "GEMINI_FREE_TIER_ONLY", maxOutputTokens: 2048, timeoutMs: 120000, thinkingLevel: "low",
    maxRetries: 3, retryBaseDelayMs: 1000, retryMaxDelayMs: 8000,
    maxClips: 8, minClipSeconds: 15, maxClipSeconds: 90, endPaddingSeconds: 0.3,
  }),
}).strict();

export type AppConfig = z.infer<typeof configSchema>;
export type ModelRate = z.infer<typeof rateSchema>;
