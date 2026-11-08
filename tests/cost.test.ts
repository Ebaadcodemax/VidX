import { describe, expect, it } from "vitest";
import { assertWithinRunBudget, estimateUsageCost } from "../src/lib/cost";

describe("configured cost table math", () => {
  const rates = {
    inputUsdPerMillionTokens: 2,
    outputUsdPerMillionTokens: 8,
    audioUsdPerMinute: 0.006,
  };

  it("calculates token and audio costs from configured rates", () => {
    expect(estimateUsageCost(rates, { inputTokens: 500_000, outputTokens: 125_000, audioSeconds: 120 }))
      .toBe(2.012);
  });

  it("rejects usage with no corresponding configured price", () => {
    expect(() => estimateUsageCost({}, { audioSeconds: 60 })).toThrow("Missing configured audio price");
  });

  it("enforces the configured per-run cap", () => {
    expect(() => assertWithinRunBudget(0.06, 0.05)).toThrow("exceeds configured cap");
    expect(() => assertWithinRunBudget(0.05, 0.05)).not.toThrow();
  });
});
