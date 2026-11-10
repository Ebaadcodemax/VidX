import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { z, type ZodType } from "zod";
import { GeminiReasoner } from "../adapters/gemini-reasoner";
import { RetryableReasonerError, type ModelUsage, type Reasoner } from "../adapters/reasoner";
import { assertWithinRunBudget, estimateUsageCost } from "../lib/cost";
import type { AppConfig } from "../schemas/config";
import { criticResponseSchema, editIrSchema, proposalSchema, proposedClipSchema, type CriticVerdict, type EditIr, type ProposedClip, type Proposal } from "../schemas/edit-ir";
import { transcriptSchema, type TranscriptDocument, type TranscriptWord } from "../schemas/transcript";

const PROMPT_DIR = resolve(__dirname, "../prompts");
const TERMINAL = /[.!?।][”’"')\]]*$/u;

export interface PlanResult { runDirectory: string; editIrPath: string; rejectedPath: string; costPath: string; clips: EditIr["clips"]; }
export interface RejectedCandidate { clip_id: string; stage: string; reason: string; candidate?: ProposedClip; critic?: CriticVerdict; }
export interface ModelCallRecord { provider: string; model: string; endpoint: string; stage: string; promptVersion: string; repairAttempt: number; attempt: number; outcome: "succeeded" | "invalid_output" | "retryable_error" | "failed"; retryStatus?: number; responseStatus?: string; thoughtTokens?: number | null; inputTokens: number | null; outputTokens: number | null; reservedCostUsd: number; estimatedCostUsd: number; elapsedMs: number; }
export interface RetryPolicy { maxRetries: number; retryBaseDelayMs: number; retryMaxDelayMs: number; maxOutputTokens: number; }

export async function runClipPlanning(transcriptFile: string, config: AppConfig, outputDirectory?: string, reasoner?: Reasoner, modelSelectionReason?: string): Promise<PlanResult> {
  const transcriptPath = resolve(transcriptFile);
  await access(transcriptPath);
  const transcript = transcriptSchema.parse(JSON.parse(await readFile(transcriptPath, "utf8")));
  const output = resolve(outputDirectory ?? join(config.runtime.defaultOutputDirectory, `${safeStem(transcript.source.fileName)}_plan_${Date.now()}`));
  if (isWithin(resolve(process.cwd()), output)) throw new Error("Run output must be outside the project directory");
  if (output === transcriptPath || isWithin(output, transcriptPath)) throw new Error("Output directory cannot contain or replace the transcript input");
  try { await access(output); throw new Error(`Output directory already exists: ${output}`); } catch (error) { if (error instanceof Error && error.message.startsWith("Output directory already exists:")) throw error; }
  await mkdir(output, { recursive: true });
  const model = reasoner ?? new GeminiReasoner(config);
  const available = await model.availability();
  if (!available.available) throw new Error(available.reason ?? "Reasoner is not configured");
  const rate = config.pricing[model.id]?.[model.model];
  if (!rate) throw new Error(`No reviewed price configured for ${model.id}/${model.model}; refusing to call provider`);
  const calls: ModelCallRecord[] = [];
  const rejected: RejectedCandidate[] = [];
  const promptProposal = await readFile(join(PROMPT_DIR, "clip-proposal-v1.md"), "utf8");
  const proposalPrompt = fill(promptProposal, {
    max_clips: String(config.reasoner.maxClips), min_seconds: String(config.reasoner.minClipSeconds), max_seconds: String(config.reasoner.maxClipSeconds),
    source_json: JSON.stringify({ file: transcript.source.fileName, sha256: transcript.source.sha256, duration_s: transcript.source.durationSeconds }),
    transcript: formatWords(transcript.words),
  });
  let proposalResult: Awaited<ReturnType<typeof generateWithRepair<Proposal>>>;
  const retryPolicy = {
    maxRetries: config.reasoner.maxRetries,
    retryBaseDelayMs: config.reasoner.retryBaseDelayMs,
    retryMaxDelayMs: config.reasoner.retryMaxDelayMs,
    maxOutputTokens: config.reasoner.maxOutputTokens,
  };
  try { proposalResult = await generateWithRepair(model, proposalPrompt, proposalSchema, "clip-proposal-v1", rate, calls, config.runtime.maxRunCostUsd, (candidate) => validateProposal(candidate, transcript, config), retryPolicy); }
  catch (error) { await writeFailure(output, transcript, model, calls, "clip-proposal-v1", error, modelSelectionReason, undefined, config.runtime.maxRunCostUsd); throw error; }
  let proposal = proposalResult.value;
  if (!proposal) {
    const raw = proposalResult.raw;
    const shell = proposalShellSchema.safeParse(raw);
    if (!shell.success) {
      const error = new Error("Gemini proposal remained invalid after one repair; no valid candidate list to review");
      await writeFailure(output, transcript, model, calls, "clip-proposal-v1", error, modelSelectionReason, raw, config.runtime.maxRunCostUsd);
      throw error;
    }
    proposal = { ...shell.data, clips: [] };
    for (const [index, candidate] of shell.data.clips.entries()) {
      const parsed = proposedClipSchema.safeParse(candidate);
      if (parsed.success) proposal.clips.push(parsed.data);
      else rejected.push({ clip_id: `candidate-${index + 1}`, stage: "proposal", reason: zodMessage(parsed.error) });
    }
  }
  const metadataOk = proposal.source.file === transcript.source.fileName && proposal.source.sha256 === transcript.source.sha256
    && Math.abs(proposal.source.duration_s - transcript.source.durationSeconds) <= 0.05;
  if (!metadataOk) throw new Error("Model source metadata did not match the transcript; refusing to plan from mismatched input");

  const snapped: ProposedClip[] = [];
  for (const candidate of proposal.clips) {
    const validationError = validateCandidate(candidate, transcript, config);
    if (validationError) { rejected.push({ clip_id: candidate.id, stage: "proposal", reason: validationError, candidate }); continue; }
    try {
      const result = snapClipBoundaries(candidate, transcript.words, transcript.source.durationSeconds, config.reasoner.endPaddingSeconds);
      const postSnapError = validateCandidate(result, transcript, config, true);
      if (postSnapError) { rejected.push({ clip_id: candidate.id, stage: "snapping", reason: postSnapError, candidate }); continue; }
      snapped.push(result);
    } catch (error) { rejected.push({ clip_id: candidate.id, stage: "snapping", reason: error instanceof Error ? error.message : "No usable word boundary", candidate }); }
  }
  const nonOverlapping = discardOverlaps(snapped, rejected);

  const promptCritic = await readFile(join(PROMPT_DIR, "critic-v1.md"), "utf8");
  const criticPrompt = fill(promptCritic, { candidates: JSON.stringify(nonOverlapping.map((clip) => ({ ...clip, transcript_excerpt: excerpt(transcript.words, clip.start_s, clip.end_s) })), null, 2) });
  let criticResult: Awaited<ReturnType<typeof generateWithRepair<z.infer<typeof criticResponseSchema>>>>;
  try { criticResult = await generateWithRepair(model, criticPrompt, criticResponseSchema, "critic-v1", rate, calls, config.runtime.maxRunCostUsd, (result) => validateCriticSet(result, nonOverlapping.map((clip) => clip.id)), retryPolicy); }
  catch (error) { await writeFailure(output, transcript, model, calls, "critic-v1", error, modelSelectionReason, undefined, config.runtime.maxRunCostUsd); throw error; }
  const verdicts = criticResult.value?.verdicts ?? [];
  const verdictById = new Map(verdicts.map((verdict) => [verdict.clip_id, verdict]));
  const accepted: EditIr["clips"] = [];
  for (const clip of nonOverlapping) {
    const verdict = verdictById.get(clip.id);
    if (!verdict) { rejected.push({ clip_id: clip.id, stage: "critic", reason: "No valid critic verdict after one repair attempt", candidate: clip }); continue; }
    const error = validateCriticVerdict(verdict, clip, transcript, nonOverlapping.map((item) => item.id));
    if (error) { rejected.push({ clip_id: clip.id, stage: "critic", reason: error, candidate: clip, critic: verdict }); continue; }
    if (verdict.verdict === "reject" || !verdict.standalone || !verdict.payoff) {
      rejected.push({ clip_id: clip.id, stage: "critic", reason: verdict.reason, candidate: clip, critic: verdict }); continue;
    }
    let finalClip = clip;
    if (verdict.verdict === "fix_boundaries") {
      const adjusted = { ...clip, start_s: verdict.suggested_start_s!, end_s: verdict.suggested_end_s! };
      const boundaryError = validateCandidate(adjusted, transcript, config);
      if (boundaryError) { rejected.push({ clip_id: clip.id, stage: "critic-fix", reason: boundaryError, candidate: clip, critic: verdict }); continue; }
      finalClip = snapClipBoundaries(adjusted, transcript.words, transcript.source.durationSeconds, config.reasoner.endPaddingSeconds);
      const snappedError = validateCandidate(finalClip, transcript, config, true);
      if (snappedError) { rejected.push({ clip_id: clip.id, stage: "critic-fix", reason: snappedError, candidate: finalClip, critic: verdict }); continue; }
    }
    accepted.push({ ...finalClip, critic: {
      verdict: verdict.verdict,
      standalone: verdict.standalone,
      hook_strength: verdict.hook_strength,
      payoff: verdict.payoff,
      reason: verdict.reason,
    } });
  }

  const finalIr = editIrSchema.parse({
    version: proposal.version,
    source: proposal.source,
    language: proposal.language,
    clips: accepted,
  });
  const totalCost = calls.reduce((sum, call) => sum + call.estimatedCostUsd, 0);
  assertWithinRunBudget(totalCost, config.runtime.maxRunCostUsd);
  const rejectedPath = join(output, "rejected-candidates.json");
  const editIrPath = join(output, "edit_ir.json");
  const costPath = join(output, "cost.json");
  await writeNew(join(output, "proposal.json"), { promptVersion: "clip-proposal-v1", proposal });
  await writeNew(join(output, "critic.json"), { promptVersion: "critic-v1", verdicts });
  await writeNew(editIrPath, finalIr);
  await writeNew(rejectedPath, { schemaVersion: "vclip-rejected-candidates/0.1", promptVersions: ["clip-proposal-v1", "critic-v1"], rejected });
  await writeNew(costPath, {
    currency: "USD", estimatedTotalUsd: totalCost, providerCalls: calls,
    costBasis: "Conservative configured standard-tier token estimate; free-tier use is confirmed by user configuration, but billing is not independently observable by vclip.",
    configuredRunCapUsd: config.runtime.maxRunCostUsd,
  });
  await writeNew(join(output, "planning.json"), {
    schemaVersion: "vclip-planning-run/0.1", startedAt: calls.length ? new Date(Date.now() - calls.reduce((sum, call) => sum + call.elapsedMs, 0)).toISOString() : new Date().toISOString(),
    completedAt: new Date().toISOString(), source: transcript.source, model: { provider: model.id, model: model.model, endpoint: model.endpoint ?? "custom-provider" },
    promptVersions: ["clip-proposal-v1", "critic-v1"], candidateCount: proposal.clips.length, acceptedCount: accepted.length,
    rejectedCount: rejected.length, modelSelectionReason: modelSelectionReason ?? "Configured model used.", note: "No media rendering occurs in M3.",
  });
  return { runDirectory: output, editIrPath, rejectedPath, costPath, clips: finalIr.clips };
}

export function snapClipBoundaries(
  clip: ProposedClip, words: TranscriptWord[], durationSeconds: number, endPaddingSeconds = 0.3,
): ProposedClip {
  if (!words.length) throw new Error("Cannot snap boundaries without word timestamps");
  const sentences = sentenceRanges(words);
  const startWordIndex = words.findIndex((word) => word.endSeconds >= clip.start_s);
  if (startWordIndex < 0) throw new Error("Clip starts after the final timestamped word; refusing to invent a boundary");
  const startSentence = sentences.find((sentence) => startWordIndex >= sentence.start && startWordIndex <= sentence.end) ?? sentences[0]!;
  const endWordIndexRaw = words.findIndex((word) => word.endSeconds >= clip.end_s);
  const endWordIndex = endWordIndexRaw < 0 ? words.length - 1 : endWordIndexRaw;
  const endSentence = sentences.find((sentence) => endWordIndex >= sentence.start && endWordIndex <= sentence.end) ?? sentences[sentences.length - 1]!;
  const start_s = words[startSentence.start]!.startSeconds;
  const end_s = Math.min(durationSeconds, words[endSentence.end]!.endSeconds + endPaddingSeconds);
  return { ...clip, start_s, end_s };
}

export function isWordAligned(time: number, words: TranscriptWord[], tolerance = 0.001): boolean {
  return words.some((word) => Math.abs(word.startSeconds - time) <= tolerance || Math.abs(word.endSeconds - time) <= tolerance);
}

export function validateCandidate(clip: ProposedClip, transcript: TranscriptDocument, config: AppConfig, requireSnapped = false): string | undefined {
  if (clip.start_s < 0 || clip.end_s > transcript.source.durationSeconds || clip.end_s <= clip.start_s) return "timestamps must satisfy 0 <= start < end <= source duration";
  const length = clip.end_s - clip.start_s;
  if (length < config.reasoner.minClipSeconds || length > config.reasoner.maxClipSeconds) return `duration ${length.toFixed(3)}s is outside configured ${config.reasoner.minClipSeconds}-${config.reasoner.maxClipSeconds}s range`;
  if (requireSnapped && (!isSentenceStart(clip.start_s, transcript.words) || !isPaddedSentenceEnd(clip.end_s, transcript.words, transcript.source.durationSeconds, config.reasoner.endPaddingSeconds))) return "clip boundaries are not aligned to sentence/word edges with configured end padding";
  if (clip.needs_context_line && !clip.context_line?.trim()) return "needs_context_line is true but context_line is empty";
  return undefined;
}

function isPaddedSentenceEnd(time: number, words: TranscriptWord[], duration: number, padding: number): boolean {
  return sentenceRanges(words).some((sentence) => {
    const end = words[sentence.end]!.endSeconds;
    return Math.abs(Math.min(duration, end + padding) - time) <= 0.001;
  });
}

function isSentenceStart(time: number, words: TranscriptWord[]): boolean {
  return sentenceRanges(words).some((sentence) => Math.abs(words[sentence.start]!.startSeconds - time) <= 0.001);
}

function sentenceRanges(words: TranscriptWord[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index < words.length; index += 1) {
    const current = words[index]!;
    const next = words[index + 1];
    if (!next || TERMINAL.test(current.text) || next.speakerId !== current.speakerId || next.startSeconds - current.endSeconds > 1.2) {
      ranges.push({ start, end: index });
      start = index + 1;
    }
  }
  return ranges;
}

export async function generateWithRepair<T>(reasoner: Reasoner, prompt: string, schema: ZodType<T>, version: string, rate: NonNullable<AppConfig["pricing"][string]>[string], calls: ModelCallRecord[], cap: number, semanticCheck?: (value: T) => string | undefined, retryPolicy: RetryPolicy = { maxRetries: 3, retryBaseDelayMs: 1000, retryMaxDelayMs: 8000, maxOutputTokens: 2048 }): Promise<{ value?: T; raw: unknown }> {
  let raw: unknown;
  let lastIssues = "model response did not match the required schema";
  for (let repairAttempt = 0; repairAttempt < 2; repairAttempt += 1) {
    const request = repairAttempt === 0 ? prompt : `${prompt}\n\nREPAIR ATTEMPT: Your previous JSON failed validation. Correct it using this deterministic validator feedback:\n${lastIssues}\nPrevious JSON (untrusted):\n${JSON.stringify(raw)}\nReturn the complete corrected JSON only.`;
    let result: { data: unknown; usage: ModelUsage } | undefined;
    for (let attempt = 0; attempt <= retryPolicy.maxRetries; attempt += 1) {
      const inputTokenReservation = reasoner.countInputTokens
        ? await reasoner.countInputTokens(request)
        : Math.ceil(request.length / 2);
      const reserve = estimateUsageCost(rate, { inputTokens: inputTokenReservation, outputTokens: retryPolicy.maxOutputTokens });
      const alreadyReserved = calls.reduce((sum, call) => sum + call.estimatedCostUsd, 0);
      assertWithinRunBudget(alreadyReserved + reserve, cap);
      const attemptStarted = Date.now();
      try {
        result = await reasoner.generateJson(request, schema);
      } catch (error) {
        const retryable = error instanceof RetryableReasonerError;
        calls.push({
          provider: reasoner.id, model: reasoner.model, endpoint: reasoner.endpoint ?? "custom-provider", stage: version, promptVersion: version, repairAttempt,
          attempt: attempt + 1, outcome: retryable && attempt < retryPolicy.maxRetries ? "retryable_error" : "failed",
          ...(retryable ? { retryStatus: error.statusCode } : {}),
          inputTokens: inputTokenReservation, outputTokens: null, reservedCostUsd: reserve,
          // Google's billing documentation says failed 5xx requests aren't billed.
          // Keep the reservation in the audit trail but release it for HTTP 503.
          estimatedCostUsd: retryable && error.statusCode === 503 ? 0 : reserve,
          elapsedMs: Date.now() - attemptStarted,
        });
        if (!retryable || attempt >= retryPolicy.maxRetries) throw error;
        const exponentialDelay = Math.min(retryPolicy.retryBaseDelayMs * (2 ** attempt), retryPolicy.retryMaxDelayMs);
        const delay = Math.min(error.retryAfterMs ?? exponentialDelay, retryPolicy.retryMaxDelayMs);
        if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
        continue;
      }
      const usedInputTokens = result.usage.inputTokens ?? inputTokenReservation;
      const cost = estimateUsageCost(rate, { inputTokens: usedInputTokens, outputTokens: result.usage.outputTokens ?? retryPolicy.maxOutputTokens });
      calls.push({ provider: reasoner.id, model: reasoner.model, endpoint: reasoner.endpoint ?? "custom-provider", stage: version, promptVersion: version, repairAttempt, attempt: attempt + 1, outcome: "succeeded", ...(result.usage.responseStatus ? { responseStatus: result.usage.responseStatus } : {}), thoughtTokens: result.usage.thoughtTokens, inputTokens: usedInputTokens, outputTokens: result.usage.outputTokens, reservedCostUsd: reserve, estimatedCostUsd: cost, elapsedMs: result.usage.elapsedMs });
      assertWithinRunBudget(calls.reduce((sum, call) => sum + call.estimatedCostUsd, 0), cap);
      break;
    }
    if (!result) throw new Error("Gemini retry loop ended without a response");
    raw = result.data;
    const parsed = schema.safeParse(raw);
    const completedCall = calls[calls.length - 1];
    if (completedCall) completedCall.outcome = parsed.success ? "succeeded" : "invalid_output";
    if (parsed.success) {
      const semanticError = semanticCheck?.(parsed.data);
      if (!semanticError) return { value: parsed.data, raw };
      lastIssues = semanticError;
    } else lastIssues = zodMessage(parsed.error);
  }
  return { raw };
}

export function validateProposal(proposal: Proposal, transcript: TranscriptDocument, config: AppConfig): string | undefined {
  if (proposal.source.file !== transcript.source.fileName || proposal.source.sha256 !== transcript.source.sha256
    || Math.abs(proposal.source.duration_s - transcript.source.durationSeconds) > 0.05) return "source metadata must exactly match the transcript source";
  if (proposal.clips.length > config.reasoner.maxClips) return `too many clips; maximum is ${config.reasoner.maxClips}`;
  const ids = new Set<string>();
  for (const clip of proposal.clips) {
    if (ids.has(clip.id)) return `duplicate clip id ${clip.id}`;
    ids.add(clip.id);
    const error = validateCandidate(clip, transcript, config);
    if (error) return `${clip.id}: ${error}`;
  }
  const ordered = [...proposal.clips].sort((a, b) => a.start_s - b.start_s);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.start_s < ordered[index - 1]!.end_s) return `overlapping clips ${ordered[index - 1]!.id} and ${ordered[index]!.id}`;
  }
  return undefined;
}

function validateCriticSet(result: z.infer<typeof criticResponseSchema>, ids: string[]): string | undefined {
  const got = result.verdicts.map((item) => item.clip_id);
  if (new Set(got).size !== got.length) return "critic returned duplicate clip IDs";
  const unknown = got.find((id) => !ids.includes(id));
  if (unknown) return `critic returned unknown clip id ${unknown}`;
  const missing = ids.find((id) => !got.includes(id));
  return missing ? `critic omitted clip id ${missing}` : undefined;
}

function validateCriticVerdict(verdict: CriticVerdict, clip: ProposedClip, transcript: TranscriptDocument, allIds: string[]): string | undefined {
  if (!allIds.includes(verdict.clip_id)) return "critic returned an unknown clip id";
  if (verdict.clip_id !== clip.id) return "critic verdict id did not match candidate";
  if (verdict.verdict === "fix_boundaries") {
    if (verdict.suggested_start_s === null || verdict.suggested_end_s === null) return "fix_boundaries verdict requires both suggested timestamps";
    if (verdict.suggested_end_s <= verdict.suggested_start_s || verdict.suggested_end_s > transcript.source.durationSeconds) return "critic suggested invalid or out-of-range boundaries";
  }
  if (verdict.verdict !== "fix_boundaries" && (verdict.suggested_start_s !== null || verdict.suggested_end_s !== null)) return "timestamp suggestions are only permitted with fix_boundaries";
  return undefined;
}

function discardOverlaps(clips: ProposedClip[], rejected: RejectedCandidate[]): ProposedClip[] {
  const sorted = [...clips].sort((a, b) => a.start_s - b.start_s || b.scores.standalone - a.scores.standalone || b.scores.hook - a.scores.hook);
  const accepted: ProposedClip[] = [];
  for (const clip of sorted) {
    const overlap = accepted.find((other) => clip.start_s < other.end_s && clip.end_s > other.start_s);
    if (overlap) rejected.push({ clip_id: clip.id, stage: "validation", reason: `overlaps accepted clip ${overlap.id}`, candidate: clip });
    else accepted.push(clip);
  }
  return accepted;
}

const proposalShellSchema = z.object({
  version: z.literal("edit-ir/0.1"),
  source: proposalSchema.shape.source,
  language: z.string().min(1),
  clips: z.array(z.unknown()),
}).strict();

function formatWords(words: TranscriptWord[]): string { return words.map((word) => `[${word.startSeconds.toFixed(3)}-${word.endSeconds.toFixed(3)}] ${word.speakerId ?? "unknown"}: ${word.text}`).join("\n"); }
function excerpt(words: TranscriptWord[], start: number, end: number): string { return words.filter((word) => word.endSeconds >= start && word.startSeconds <= end).map((word) => word.text).join(" "); }
function fill(template: string, values: Record<string, string>): string { return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{{${key}}}`, value), template); }
function safeStem(fileName: string): string { return basename(fileName).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 48) || "transcript"; }
function isWithin(parent: string, child: string): boolean { const rel = relative(resolve(parent), resolve(child)); return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !rel.startsWith("/")); }
function zodMessage(error: z.ZodError): string { return error.issues.map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`).join("; "); }
async function writeNew(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", encoding: "utf8" }); }
async function writeFailure(output: string, transcript: TranscriptDocument, model: Reasoner, calls: ModelCallRecord[], stage: string, error: unknown, modelSelectionReason?: string, modelOutput?: unknown, configuredCapUsd = 0.05): Promise<void> {
  const total = calls.reduce((sum, call) => sum + call.estimatedCostUsd, 0);
  const costRecord = { currency: "USD", estimatedTotalUsd: total, providerCalls: calls, configuredRunCapUsd: configuredCapUsd, costBasis: "Actual provider token usage when returned; conservative reservation otherwise. Google documents failed 5xx requests as unbilled; those attempts retain their held reservation separately." };
  await writeNew(join(output, "cost.json"), costRecord).catch(() => undefined);
  await writeNew(join(output, "failure.json"), { schemaVersion: "vclip-planning-failure/0.1", failedAt: new Date().toISOString(), stage, source: transcript.source, model: { provider: model.id, model: model.model, endpoint: model.endpoint ?? "custom-provider" }, modelSelectionReason: modelSelectionReason ?? "Configured model used.", calls, estimatedTotalUsd: total, safeMessage: error instanceof Error ? error.message : "Planning failed", ...(modelOutput === undefined ? {} : { invalidModelOutput: modelOutput }) }).catch(() => undefined);
}
