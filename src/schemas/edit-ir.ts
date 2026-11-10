import { z } from "zod";

const scoreSchema = z.number().finite().min(0).max(1);
const clipOutputSchema = z.object({ aspect: z.literal("9:16"), max_duration_s: z.number().positive().max(90) }).strict();
const captionsSchema = z.object({ style: z.string().min(1), language: z.string().min(1) }).strict();

export const proposedClipSchema = z.object({
  id: z.string().min(1).max(64),
  start_s: z.number().finite().nonnegative(),
  end_s: z.number().finite().positive(),
  title: z.string().min(1).max(160),
  hook_text: z.string().min(1),
  payoff: z.string().min(1),
  reason: z.string().min(1),
  scores: z.object({ hook: scoreSchema, standalone: scoreSchema, payoff: scoreSchema, emotion: scoreSchema }).strict(),
  needs_context_line: z.boolean(),
  context_line: z.string().nullable(),
  speakers: z.array(z.string()),
  captions: captionsSchema,
  output: clipOutputSchema,
}).strict();

export const proposalSchema = z.object({
  version: z.literal("edit-ir/0.1"),
  source: z.object({ file: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), duration_s: z.number().positive() }).strict(),
  language: z.string().min(1),
  clips: z.array(proposedClipSchema),
}).strict();

export const criticVerdictSchema = z.object({
  clip_id: z.string().min(1),
  verdict: z.enum(["keep", "fix_boundaries", "reject"]),
  standalone: z.boolean(),
  hook_strength: z.number().int().min(1).max(5),
  payoff: z.boolean(),
  reason: z.string().min(1),
  suggested_start_s: z.number().finite().nonnegative().nullable(),
  suggested_end_s: z.number().finite().positive().nullable(),
}).strict();

export const criticResponseSchema = z.object({
  verdicts: z.array(criticVerdictSchema),
}).strict();

export const finalClipSchema = proposedClipSchema.extend({
  critic: z.object({
    verdict: z.enum(["keep", "fix_boundaries"]),
    standalone: z.boolean(),
    hook_strength: z.number().int().min(1).max(5),
    payoff: z.boolean(),
    reason: z.string().min(1),
  }).strict(),
}).strict();

export const editIrSchema = z.object({
  version: z.literal("edit-ir/0.1"),
  source: z.object({ file: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), duration_s: z.number().positive() }).strict(),
  language: z.string().min(1),
  clips: z.array(finalClipSchema),
}).strict();

export type ProposedClip = z.infer<typeof proposedClipSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type CriticVerdict = z.infer<typeof criticVerdictSchema>;
export type EditIr = z.infer<typeof editIrSchema>;
