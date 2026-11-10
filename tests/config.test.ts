import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/lib/config";

const original = process.env.MAX_RUN_COST_USD;
afterEach(() => {
  if (original === undefined) delete process.env.MAX_RUN_COST_USD;
  else process.env.MAX_RUN_COST_USD = original;
});

describe("MAX_RUN_COST_USD override", () => {
  it("can lower but cannot raise the configured hard run cap", async () => {
    process.env.MAX_RUN_COST_USD = "0.01";
    expect((await loadConfig()).runtime.maxRunCostUsd).toBe(0.01);
    process.env.MAX_RUN_COST_USD = "0.50";
    expect((await loadConfig()).runtime.maxRunCostUsd).toBe(0.05);
  });

  it("rejects invalid environment caps", async () => {
    process.env.MAX_RUN_COST_USD = "unlimited";
    await expect(loadConfig()).rejects.toThrow("MAX_RUN_COST_USD must be a positive number");
  });
});
