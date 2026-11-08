import type { AppConfig, ModelRate } from "../schemas/config";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  audioSeconds?: number;
}

export interface CostEntry {
  provider: string;
  model: string;
  usage: Usage;
  estimatedCostUsd: number;
}

export function estimateUsageCost(rate: ModelRate, usage: Usage): number {
  const inputTokens = nonNegative(usage.inputTokens ?? 0, "inputTokens");
  const outputTokens = nonNegative(usage.outputTokens ?? 0, "outputTokens");
  const audioSeconds = nonNegative(usage.audioSeconds ?? 0, "audioSeconds");

  if (inputTokens > 0 && rate.inputUsdPerMillionTokens === undefined) {
    throw new Error("Missing configured input-token price");
  }
  if (outputTokens > 0 && rate.outputUsdPerMillionTokens === undefined) {
    throw new Error("Missing configured output-token price");
  }
  if (audioSeconds > 0 && rate.audioUsdPerMinute === undefined) {
    throw new Error("Missing configured audio price");
  }

  const total = inputTokens * (rate.inputUsdPerMillionTokens ?? 0) / 1_000_000
    + outputTokens * (rate.outputUsdPerMillionTokens ?? 0) / 1_000_000
    + audioSeconds * (rate.audioUsdPerMinute ?? 0) / 60;
  return roundCurrency(total);
}

export function createCostEntry(
  config: AppConfig,
  provider: string,
  model: string,
  usage: Usage,
): CostEntry {
  const rate = config.pricing[provider]?.[model];
  if (!rate) throw new Error(`No reviewed price configured for ${provider}/${model}`);
  return { provider, model, usage, estimatedCostUsd: estimateUsageCost(rate, usage) };
}

export function assertWithinRunBudget(totalUsd: number, limitUsd: number): void {
  if (totalUsd > limitUsd) {
    throw new Error(`Run cost $${totalUsd.toFixed(4)} exceeds configured cap $${limitUsd.toFixed(4)}`);
  }
}

function nonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be a finite non-negative number`);
  return value;
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}
