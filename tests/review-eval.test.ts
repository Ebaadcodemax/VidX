import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRandom, parseRatingsCsv, purge, randomizePairs, usableRate, wilsonInterval } from "../src/pipeline/review-eval";

describe("M5 evaluation helpers", () => {
  it("calculates usable rate and 95% Wilson interval with the sample size", () => {
    expect(usableRate([{ rating: "yes_as_is" }, { rating: "no" }, { rating: "yes_minor_edits" }])).toEqual({
      successes: 2, n: 3, rate: 2 / 3, interval: [0.2076549551264879, 0.9385096847238394],
    });
    expect(wilsonInterval(0, 0)).toEqual([0, 0]);
  });

  it("parses quoted fields and counts malformed rating rows", () => {
    const csv = [
      "run_id,clip_id,rater,rating,notes,would_post,edited_before_posting",
      'r1,c1,reviewer,yes_as_is,"has, comma and ""quote""",yes,false',
      "r1,c2,reviewer,no,broken,maybe,false",
      "r1,c3,reviewer,yes_minor_edits,short",
      'r1,c4,reviewer,yes_as_is,"unclosed',
    ].join("\r\n");
    const parsed = parseRatingsCsv(csv);
    expect(parsed.ratings).toHaveLength(1);
    expect(parsed.ratings[0]?.notes).toBe('has, comma and "quote"');
    expect(parsed.malformed).toBe(3);
  });

  it("assigns A/B labels repeatably from a fixed seed", () => {
    const pairs: Array<[string, string]> = [["ours-1", "competitor-1"], ["ours-2", "competitor-2"], ["ours-3", "competitor-3"]];
    const first = randomizePairs(pairs, createSeededRandom(271828));
    const second = randomizePairs(pairs, createSeededRandom(271828));
    expect(first).toEqual(second);
    expect(first.every((p) => p.a !== p.b)).toBe(true);
    expect(first.map((p) => p.aIsFirst)).toContain(false);
    expect(first.map((p) => p.aIsFirst)).toContain(true);
  });

  it("purge dry-run reports matching run and ratings without deleting either", async () => {
    const root = await mkdtemp(join(tmpdir(), "vclip-purge-test-"));
    try {
      const runs = join(root, "runs"), evalDir = join(root, "eval"), run = join(runs, "creator7-run-a");
      await mkdir(run, { recursive: true }); await mkdir(evalDir, { recursive: true });
      await writeFile(join(run, "render.json"), JSON.stringify({ source: { creatorId: "creator7" } }));
      await writeFile(join(evalDir, "ratings.csv"), "run_id,clip_id,rater,rating,notes,would_post,edited_before_posting\r\ncreator7-run-a,c1,r,no,,no,false\r\n");
      const result = await purge("creator7", runs, evalDir, true, async () => { throw new Error("dry run must not ask for confirmation"); });
      expect(result).toEqual({ deletedRuns: 1, removedRatings: 1 });
      await expect(readFile(join(run, "render.json"), "utf8")).resolves.toContain("creatorId");
      await expect(readFile(join(evalDir, "ratings.csv"), "utf8")).resolves.toContain("creator7-run-a");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
