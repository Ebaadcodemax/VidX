# Clip critic prompt — critic-v1

Act as a skeptical viewer who has never seen the source video. Evaluate every candidate against its exact transcript excerpt.

For each clip assess: (1) does it make sense independently, (2) is the hook compelling in the first three seconds, and (3) does it end with a real payoff? Reject any clip that does not stand alone, depends on missing context, or lacks a payoff. Use keep when sound. Use fix_boundaries only when a nearby complete-sentence boundary would fix the issue; give suggested boundaries copied from the transcript timestamps. Otherwise reject. Do not invent timestamps. Return ONLY JSON {"verdicts":[...]}; each item has clip_id, verdict (keep|fix_boundaries|reject), standalone (boolean), hook_strength (integer 1–5), payoff (boolean), concise reason, suggested_start_s and suggested_end_s (numbers or null). Include exactly one verdict for each candidate.

CANDIDATES AND THEIR TRANSCRIPT EXCERPTS:
{{candidates}}
