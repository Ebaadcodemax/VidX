import { randomBytes } from "node:crypto";
import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { editIrSchema, type EditIr } from "../schemas/edit-ir";
import { transcriptSchema } from "../schemas/transcript";

export const RATING_COLUMNS = ["run_id", "clip_id", "rater", "rating", "notes", "would_post", "edited_before_posting"] as const;
export type Rating = { run_id: string; clip_id: string; rater: string; rating: "yes_as_is" | "yes_minor_edits" | "no"; notes: string; would_post: "yes" | "no"; edited_before_posting: "true" | "false" };
export type ReviewOptions = { editIrPath?: string; transcriptPath?: string; keyDirectory?: string; random?: () => number };

export function wilsonInterval(successes: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 0];
  const p = successes / n, z2 = z * z, denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) / n) + z2 / (4 * n * n)) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export function usableRate(ratings: Pick<Rating, "rating">[]): { successes: number; n: number; rate: number; interval: [number, number] } {
  const successes = ratings.filter((r) => r.rating === "yes_as_is" || r.rating === "yes_minor_edits").length;
  return { successes, n: ratings.length, rate: ratings.length ? successes / ratings.length : 0, interval: wilsonInterval(successes, ratings.length) };
}

export function parseCsv(text: string): { rows: string[][]; malformed: number } {
  const rows: string[][] = []; let row: string[] = [], field = "", quoted = false, malformed = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field.length === 0) quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v.length)) rows.push(row);
      row = [];
    } else field += c;
  }
  if (quoted) malformed++;
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return { rows: malformed ? rows.slice(0, -1) : rows, malformed };
}

export function parseRatingsCsv(text: string): { ratings: Rating[]; malformed: number } {
  const parsed = parseCsv(text); if (!parsed.rows.length) return { ratings: [], malformed: parsed.malformed };
  const header = parsed.rows[0]!.map((v) => v.trim().replace(/^\uFEFF/, ""));
  if (RATING_COLUMNS.some((column) => !header.includes(column))) return { ratings: [], malformed: parsed.malformed + Math.max(1, parsed.rows.length - 1) };
  let malformed = parsed.malformed; const ratings: Rating[] = [];
  for (const row of parsed.rows.slice(1)) {
    if (row.length !== header.length) { malformed++; continue; }
    const value = Object.fromEntries(header.map((key, index) => [key, row[index] ?? ""])) as Record<string, string>;
    if (!value.rating?.trim()) continue;
    if (!value.run_id?.trim() || !value.clip_id?.trim() || !["yes_as_is", "yes_minor_edits", "no"].includes(value.rating) || !["yes", "no"].includes(value.would_post) || !["true", "false"].includes(value.edited_before_posting)) { malformed++; continue; }
    ratings.push({ run_id: value.run_id, clip_id: value.clip_id, rater: value.rater ?? "", rating: value.rating as Rating["rating"], notes: value.notes ?? "", would_post: value.would_post as "yes" | "no", edited_before_posting: value.edited_before_posting as "true" | "false" });
  }
  return { ratings, malformed };
}

export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function randomizePairs<A, B>(pairs: Array<[A, B]>, random: () => number = Math.random): Array<{ pairId: string; a: A | B; b: A | B; aIsFirst: boolean }> {
  return pairs.map((pair, index) => {
    const aIsFirst = random() < 0.5;
    const [first, second] = pair;
    return { pairId: `pair_${index + 1}`, a: aIsFirst ? first : second, b: aIsFirst ? second : first, aIsFirst };
  });
}

export async function createReviewSheet(runDirectory: string, options: ReviewOptions = {}): Promise<{ htmlPath: string; csvPath: string; keyPath?: string }> {
  const dir = resolve(runDirectory), runId = basename(dir);
  const render = JSON.parse(await readFile(join(dir, "render.json"), "utf8")) as { clips?: Array<{ id: string; videoPath: string }>; source?: { sha256?: string } };
  const editPath = resolve(options.editIrPath ?? join(dir, "edit_ir.json"));
  const transcriptPath = resolve(options.transcriptPath ?? join(dir, "transcript.json"));
  const ir: EditIr = editIrSchema.parse(JSON.parse(await readFile(editPath, "utf8")));
  const transcript = transcriptSchema.parse(JSON.parse(await readFile(transcriptPath, "utf8")));
  if (render.source?.sha256 !== ir.source.sha256 || render.source?.sha256 !== transcript.source.sha256) throw new Error("Render, Edit IR, and transcript source hashes must match");
  const renderClips = new Map((render.clips ?? []).map((clip) => [clip.id, clip]));
  for (const rendered of renderClips.values()) await access(join(dir, toPortablePath(dir, rendered.videoPath)));
  const clips = ir.clips.filter((clip) => renderClips.has(clip.id)).map((clip) => {
    const rendered = renderClips.get(clip.id)!;
    const words = transcript.words.filter((word) => word.endSeconds > clip.start_s && word.startSeconds < clip.end_s).map((word) => word.text);
    return { id: clip.id, title: clip.title, start: clip.start_s, end: clip.end_s, reason: clip.reason, transcript: words.join(" "), verdict: clip.critic.verdict, criticReason: clip.critic.reason, needsContext: clip.needs_context_line, contextLine: clip.context_line, video: toPortablePath(dir, rendered.videoPath) };
  });
  if (!clips.length) throw new Error("No Edit IR clips have matching rendered files in render.json");
  const rows = [RATING_COLUMNS.join(","), ...clips.map((clip) => [runId, clip.id, "", "", "", "", ""].map(csvEscape).join(","))].join("\r\n") + "\r\n";
  const htmlPath = join(dir, "review.html"), csvPath = join(dir, "review.csv");
  const serialized = JSON.stringify(clips).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  await writeFile(htmlPath, reviewHtml(runId, serialized), "utf8");
  await writeFile(csvPath, rows, "utf8");
  await writeFile(join(dir, "review.json"), JSON.stringify({ schemaVersion: "vclip-review/0.1", runId, sourceSha256: ir.source.sha256, editIrPath: editPath, transcriptPath, generatedAt: new Date().toISOString() }, null, 2) + "\n", "utf8");
  return { htmlPath, csvPath };
}

export async function createBlindReview(runDirectory: string, competitorDirectory: string, options: ReviewOptions = {}): Promise<{ htmlPath: string; keyPath: string }> {
  await createReviewSheet(runDirectory, options);
  const dir = resolve(runDirectory), runId = basename(dir), competitors = await listVideos(resolve(competitorDirectory));
  const render = JSON.parse(await readFile(join(dir, "render.json"), "utf8")) as { clips?: Array<{ id: string; videoPath: string }> };
  const own = (render.clips ?? []).filter((c) => extname(c.videoPath).toLowerCase() === ".mp4");
  if (own.length !== competitors.length) throw new Error(`Blind A/B requires an equal number of own and competitor clips; got ${own.length} and ${competitors.length}`);
  const randomBytesSeed = randomBytes(4).readUInt32LE(0);
  const comparisonId = randomBytes(16).toString("hex");
  const random = options.random ?? createSeededRandom(randomBytesSeed);
  const assignments = randomizePairs(own.map((clip, i) => [
    { kind: "ours" as const, clip },
    { kind: "competitor" as const, path: competitors[i]! },
  ] as [
    { kind: "ours"; clip: (typeof own)[number] },
    { kind: "competitor"; path: string },
  ]), random);
  const keyRows: Array<Record<string, string>> = [], publicPairs: Array<{ pairId: string; a: string; b: string }> = [];
  const blindDir = join(dir, "blind-review"), compareDir = join(blindDir, "assets"); await mkdir(compareDir, { recursive: true });
  for (let i = 0; i < assignments.length; i++) {
    const assignment = assignments[i]!, pairId = `pair_${i + 1}`;
    const aIsOwn = assignment.a.kind === "ours";
    const ownClip = (aIsOwn ? assignment.a : assignment.b) as { kind: "ours"; clip: (typeof own)[number] };
    const competitor = (aIsOwn ? assignment.b : assignment.a) as { kind: "competitor"; path: string };
    const ownA = aIsOwn;
    const ownCopy = join(compareDir, `${randomBytes(12).toString("hex")}.mp4`);
    const compCopy = join(compareDir, `${randomBytes(12).toString("hex")}${extname(competitor.path).toLowerCase()}`);
    await Promise.all([copyFile(ownClip.clip.videoPath, ownCopy), copyFile(competitor.path, compCopy)]);
    const ownRelative = relative(blindDir, ownCopy).split(sep).join("/");
    const competitorRelative = relative(blindDir, compCopy).split(sep).join("/");
    const aPath = ownA ? ownRelative : competitorRelative;
    const bPath = ownA ? competitorRelative : ownRelative;
    publicPairs.push({ pairId, a: aPath, b: bPath });
    keyRows.push({ pair_id: pairId, own_clip_id: ownClip.clip.id, own_label: ownA ? "A" : "B", competitor_file: basename(competitor.path) });
  }
  const htmlPath = join(blindDir, "review.html"), keyDir = resolve(options.keyDirectory ?? "C:/vclip-data/blind-keys");
  const keyPath = join(keyDir, runId, "key.json"); await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, JSON.stringify({ runId, comparisonId, mapping: keyRows }, null, 2) + "\n", "utf8");
  const abHtmlPath = htmlPath;
  await writeFile(htmlPath, blindHtml(comparisonId, publicPairs), "utf8");
  await writeFile(join(blindDir, "ab-review.csv"), "run_id,pair_id,winner,reason\r\n" + publicPairs.map((p) => `${csvEscape(comparisonId)},${csvEscape(p.pairId)},,`).join("\r\n") + "\r\n", "utf8");
  return { htmlPath: abHtmlPath, keyPath };
}

export async function evaluate(evalDirectory: string, runsDirectory: string, reportPath: string): Promise<{ reportPath: string; ratings: number; malformed: number }> {
  const evalDir = resolve(evalDirectory), runsDir = resolve(runsDirectory); await mkdir(evalDir, { recursive: true });
  const ratingFiles = await walk(evalDir, (path) => path.toLowerCase().endsWith(".csv") && !basename(path).toLowerCase().startsWith("review") && !["ab-review.csv", "ab_ratings.csv"].includes(basename(path).toLowerCase()));
  const ratings: Rating[] = []; let malformed = 0;
  for (const file of ratingFiles) { const parsed = parseRatingsCsv(await readFile(file, "utf8")); ratings.push(...parsed.ratings); malformed += parsed.malformed; }
  const metrics = await collectRunMetrics(runsDir);
  const byRun = groupBy(ratings, (r) => r.run_id), byRater = groupBy(ratings, (r) => r.rater || "(blank)");
  const abFiles = await walk(evalDir, (path) => basename(path).toLowerCase() === "ab_ratings.csv" || basename(path).toLowerCase() === "ab-review.csv");
  const wins = new Map<string, number>(); let abCount = 0;
  for (const file of abFiles) {
    const rows = parseCsv(await readFile(file, "utf8")).rows; if (!rows.length) continue;
    const header = rows[0]!.map((s) => s.trim()); const wi = header.indexOf("winner");
    if (wi < 0) continue;
    for (const row of rows.slice(1)) { const winner = row[wi]?.trim().toUpperCase(); if (winner === "A" || winner === "B" || winner === "TIE") { wins.set(winner, (wins.get(winner) ?? 0) + 1); abCount++; } }
  }
  const overall = usableRate(ratings);
  const report = ["# vclip Evaluation Report", "", `Generated: ${new Date().toISOString()}`, "", "## Human ratings", "", `Usable rate: **${pct(overall.rate)}** (${overall.successes}/${overall.n} rated clips; 95% Wilson CI ${pct(overall.interval[0])}–${pct(overall.interval[1])}).`, ...(overall.n < 20 ? ["Small sample: fewer than 20 ratings gives a noisy estimate; treat this as directional feedback, not a reliable quality claim."] : []), `Malformed or incomplete rows skipped: ${malformed}.`, "", "### By run", "", mdRatingTable(byRun), "", "### By rater", "", mdRatingTable(byRater), "", "## Production metrics by run", "", "Metrics are calculated from locally saved run metadata. Missing metadata is shown as unavailable; no media or transcript is sent to a provider.", "", "| Run | Median clip duration | Clips needing context | Cost / source hour | Render time / source hour | Total recorded wall time / source hour |", "|---|---:|---:|---:|---:|---:|", ...metrics.map((m) => `| ${md(m.runId)} | ${m.medianDuration == null ? "n/a" : `${m.medianDuration.toFixed(1)}s`} | ${m.contextShare == null ? "n/a" : pct(m.contextShare)} | ${m.costPerHour == null ? "n/a" : `$${m.costPerHour.toFixed(4)}`} | ${m.renderPerHour == null ? "n/a" : `${m.renderPerHour.toFixed(2)}s`} | ${m.totalPerHour == null ? "n/a" : `${m.totalPerHour.toFixed(2)}s`} |`), "", "## Blind A/B", "", `Rated pairs: ${abCount}; wins: A ${wins.get("A") ?? 0}, B ${wins.get("B") ?? 0}, ties ${wins.get("TIE") ?? 0}.`, ""];
  await mkdir(resolve(reportPath, ".."), { recursive: true }); await writeFile(reportPath, report.join("\n"), "utf8");
  return { reportPath: resolve(reportPath), ratings: ratings.length, malformed };
}

export async function planPurge(target: string, runsDirectory: string, evalDirectory: string): Promise<{ runDirs: string[]; ratingRowsByFile: Record<string, number> }> {
  const root = resolve(runsDirectory);
  const runs = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
  const needle = target.toLowerCase(), resolvedTarget = resolve(target).toLowerCase(), matched: string[] = [];
  for (const dir of runs) {
    const name = basename(dir).toLowerCase(); let match = name === needle || resolve(dir).toLowerCase() === resolvedTarget || name.startsWith(`${needle}_`) || name.startsWith(`${needle}-`);
    for (const file of ["render.json", "manifest.json", "planning.json", "edit_ir.json"]) {
      try { const obj = JSON.parse(await readFile(join(dir, file), "utf8")) as Record<string, unknown>; const metadata = [obj.creatorId, obj.creatorName, (obj.source as Record<string, unknown> | undefined)?.creatorId, (obj.source as Record<string, unknown> | undefined)?.creatorName].filter((x): x is string => typeof x === "string"); if (metadata.some((x) => x.toLowerCase() === needle)) match = true; } catch { /* absent optional metadata */ }
    }
    if (match) matched.push(dir);
  }
  const runIds = new Set(matched.map((dir) => basename(dir).toLowerCase())), rowsByFile: Record<string, number> = {};
  for (const file of await walk(resolve(evalDirectory), (path) => path.toLowerCase().endsWith(".csv"))) {
    const text = await readFile(file, "utf8"), rows = parseCsv(text).rows; if (!rows.length) continue;
    const hi = rows[0]!.map((s) => s.trim()).indexOf("run_id"); if (hi < 0) continue;
    rowsByFile[file] = rows.slice(1).filter((row) => runIds.has((row[hi] ?? "").toLowerCase())).length;
  }
  return { runDirs: matched, ratingRowsByFile: rowsByFile };
}

export async function purge(target: string, runsDirectory: string, evalDirectory: string, dryRun: boolean, confirm: () => Promise<boolean>): Promise<{ deletedRuns: number; removedRatings: number }> {
  const plan = await planPurge(target, runsDirectory, evalDirectory); if (dryRun) return { deletedRuns: plan.runDirs.length, removedRatings: Object.values(plan.ratingRowsByFile).reduce((a, b) => a + b, 0) };
  if (!(await confirm())) throw new Error("Purge cancelled; no data was deleted");
  const ids = new Set(plan.runDirs.map((dir) => basename(dir).toLowerCase()));
  for (const dir of plan.runDirs) await rm(dir, { recursive: true, force: true });
  let removedRatings = 0;
  for (const file of Object.keys(plan.ratingRowsByFile)) {
    const rows = parseCsv(await readFile(file, "utf8")).rows; if (!rows.length) continue;
    const header = rows[0]!, runCol = header.findIndex((s) => s.trim() === "run_id");
    if (runCol < 0) continue;
    const keep = rows.filter((row, i) => i === 0 || !ids.has((row[runCol] ?? "").toLowerCase())); removedRatings += rows.length - keep.length;
    await writeFile(file, keep.map((row) => row.map(csvEscape).join(",")).join("\r\n") + "\r\n", "utf8");
  }
  const auditDir = resolve("C:/vclip-data/audit"); await mkdir(auditDir, { recursive: true });
  await writeFile(join(auditDir, "purge.log"), `${new Date().toISOString()} purge_completed runs=${plan.runDirs.length} rating_rows=${removedRatings}\n`, { flag: "a", encoding: "utf8" });
  return { deletedRuns: plan.runDirs.length, removedRatings };
}

function reviewHtml(runId: string, data: string): string { return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>vclip review — ${escapeHtml(runId)}</title><style>body{font:16px system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#18212b;background:#f5f7fa}header,.clip{background:white;padding:1.25rem;border:1px solid #d7dee8;border-radius:10px;margin:1rem 0}.clip video{width:min(100%,560px);background:#111}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1rem}label{display:block;margin:.55rem 0}textarea,input[type=text]{width:100%;box-sizing:border-box;padding:.5rem}button{padding:.6rem 1rem;margin:.5rem .5rem .5rem 0;cursor:pointer}.rating label{display:inline-block;margin-right:1rem}small{color:#526171}</style><body><header><h1>Clip review: ${escapeHtml(runId)}</h1><p>Offline review sheet. Ratings stay in this browser until you download them.</p><label>Rater name/ID <input id="rater" type="text" autocomplete="off"></label><button id="download">Download ratings.csv</button></header><main id="clips"></main><script>const runId=${JSON.stringify(runId)},clips=${data};const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const root=document.getElementById('clips');for(const c of clips){const section=document.createElement('section');section.className='clip';section.innerHTML='<h2>'+esc(c.title)+'</h2><video controls preload="metadata" src="'+esc(c.video)+'"></video><p><b>Source:</b> '+c.start.toFixed(2)+'–'+c.end.toFixed(2)+'s</p><p><b>Reason:</b> '+esc(c.reason)+'</p><p><b>Transcript:</b> '+esc(c.transcript)+'</p><p><b>Critic:</b> '+esc(c.verdict)+' — '+esc(c.criticReason)+'</p><p><b>Context line required:</b> '+(c.needsContext?'Yes'+(c.contextLine?' — '+esc(c.contextLine):''):'No')+'</p><div class="rating"><b>Rating:</b>'+['yes_as_is','yes_minor_edits','no'].map(v=>'<label><input type="radio" name="rating-'+esc(c.id)+'" value="'+v+'"> '+v+'</label>').join('')+'</div><div class="grid"><label>Would post?<select data-field="would_post"><option value="">Select</option><option>yes</option><option>no</option></select></label><label><input type="checkbox" data-field="edited_before_posting"> Edited before posting</label></div><label>Notes<textarea data-field="notes" rows="3"></textarea></label></section>';root.append(section)}document.getElementById('download').onclick=()=>{const rows=[${JSON.stringify(RATING_COLUMNS)}];for(const c of clips){const card=[...document.querySelectorAll('.clip')][clips.indexOf(c)],rating=card.querySelector('input[name="rating-'+CSS.escape(c.id)+'"]:checked')?.value||'',would=card.querySelector('[data-field="would_post"]').value,edited=card.querySelector('[data-field="edited_before_posting"]').checked?'true':'false',notes=card.querySelector('[data-field="notes"]').value;if(rating)rows.push([runId,c.id,document.getElementById('rater').value,rating,notes,would,edited])}const csv=rows.map(row=>row.map(v=> '"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\\r\\n')+'\\r\\n',blob=new Blob([csv],{type:'text/csv;charset=utf-8'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='ratings.csv';a.click();URL.revokeObjectURL(a.href)};</script></body></html>`; }
function blindHtml(runId: string, pairs: Array<{ pairId: string; a: string; b: string }>): string { return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Blind comparison — ${escapeHtml(runId)}</title><style>body{font:16px system-ui,sans-serif;max-width:1200px;margin:2rem auto;padding:0 1rem;background:#f5f7fa}.pair{background:#fff;border:1px solid #ccd;padding:1rem;margin:1rem 0}video{width:100%;background:#111}.cols{display:grid;grid-template-columns:1fr 1fr;gap:1rem}textarea{width:100%;min-height:3rem}</style><body><h1>Blind clip comparison</h1><label>Rater <input id="rater"></label><main>${pairs.map((p) => `<section class="pair" data-id="${escapeHtml(p.pairId)}"><h2>${escapeHtml(p.pairId)}</h2><div class="cols"><div><h3>Clip A</h3><video controls preload="metadata" src="${escapeHtml(p.a)}"></video></div><div><h3>Clip B</h3><video controls preload="metadata" src="${escapeHtml(p.b)}"></video></div></div><label>Winner <select><option value="">Choose</option><option>A</option><option>B</option><option>TIE</option></select></label><label>Reason <textarea></textarea></label></section>`).join("")}</main><button id="download">Download ab_ratings.csv</button><script>const run=${JSON.stringify(runId)};document.getElementById('download').onclick=()=>{const rows=[['run_id','pair_id','winner','reason','rater'],...Array.from(document.querySelectorAll('.pair')).filter(p=>p.querySelector('select').value).map(p=>[run,p.dataset.id,p.querySelector('select').value,p.querySelector('textarea').value,document.getElementById('rater').value])],csv=rows.map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\\r\\n')+'\\r\\n',a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='ab_ratings.csv';a.click()};</script></body></html>`; }
function toPortablePath(root: string, file: string): string { const path = resolve(file); const rel = relative(root, path); if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`Rendered clip must be inside the review folder for portable sharing: ${file}`); return rel.split(sep).join("/"); }
function csvEscape(value: unknown): string { const s = String(value ?? ""); return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
async function listVideos(dir: string): Promise<string[]> { const paths = await walk(dir, (p) => [".mp4", ".mov", ".webm"].includes(extname(p).toLowerCase())); return paths.sort((a, b) => a.localeCompare(b)); }
async function walk(root: string, predicate: (path: string) => boolean | Promise<boolean>): Promise<string[]> { let entries; try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; } const found: string[] = []; for (const e of entries) { const path = join(root, e.name); if (e.isDirectory()) found.push(...await walk(path, predicate)); else if (await predicate(path)) found.push(path); } return found; }
async function collectRunMetrics(runsDirectory: string): Promise<Array<{ runId: string; medianDuration: number | null; contextShare: number | null; costPerHour: number | null; renderPerHour: number | null; totalPerHour: number | null }>> {
  const runDirs = await readdir(runsDirectory, { withFileTypes: true }).catch(() => []), records: Array<{ runId: string; hash: string; sourceDuration: number; clips: EditIr["clips"]; renderMs: number; totalMs: number | null; cost: number | null }> = [];
  const sidecars = await walk(runsDirectory, (p) => ["edit_ir.json", "transcript.json", "planning.json", "cost.json"].includes(basename(p)));
  const json = new Map<string, unknown>(); for (const f of sidecars) try { json.set(f, JSON.parse(await readFile(f, "utf8"))); } catch { /* malformed sidecar ignored */ }
  for (const entry of runDirs.filter((e) => e.isDirectory())) {
    const dir = join(runsDirectory, entry.name); let render: any, ir: any;
    try { render = JSON.parse(await readFile(join(dir, "render.json"), "utf8")); } catch { continue; }
    const hash = render.source?.sha256; if (!hash) continue;
    try { ir = JSON.parse(await readFile(join(dir, render.editIr ?? "edit_ir.json"), "utf8")); } catch { ir = [...json.values()].find((v: any) => v?.version === "edit-ir/0.1" && v.source?.sha256 === hash); }
    const clips = Array.isArray(ir?.clips) ? ir.clips : [];
    let totalMs: number | null = Number(render.elapsedMs ?? 0), cost: number | null = Number(render.estimatedCostUsd ?? 0), reviewMetadata: any;
    try { reviewMetadata = JSON.parse(await readFile(join(dir, "review.json"), "utf8")); } catch { /* review metadata is optional */ }
    if (reviewMetadata?.sourceSha256 === hash) {
      let complete = true;
      try { const transcript = JSON.parse(await readFile(reviewMetadata.transcriptPath, "utf8")); totalMs += Number(transcript.timing?.elapsedMs ?? 0); cost += Number(transcript.usage?.estimatedCostUsd ?? 0); } catch { complete = false; }
      try { const planning = JSON.parse(await readFile(join(dirname(reviewMetadata.editIrPath), "planning.json"), "utf8")); if (planning.startedAt && planning.completedAt) totalMs += Math.max(0, Date.parse(planning.completedAt) - Date.parse(planning.startedAt)); else complete = false; } catch { complete = false; }
      try { const planningCost = JSON.parse(await readFile(join(dirname(reviewMetadata.editIrPath), "cost.json"), "utf8")); cost = (cost ?? 0) + Number(planningCost.estimatedTotalUsd ?? 0); } catch { complete = false; }
      try { const rc = JSON.parse(await readFile(join(dir, "cost.json"), "utf8")); cost = (cost ?? 0) + Number(rc.estimatedTotalUsd ?? 0); } catch { complete = false; }
      if (!complete) { totalMs = null; cost = null; }
    } else {
      // Older render runs do not record the exact M2/M3 sidecars used. Report
      // render time alone and leave end-to-end wall time/cost unavailable.
      totalMs = null; cost = null;
    }
    const duration = Number(render.source.durationSeconds ?? 0); if (!duration) continue;
    const sorted = clips.map((c: any) => Number(c.end_s) - Number(c.start_s)).filter(Number.isFinite).sort((a: number, b: number) => a - b);
    const median = sorted.length ? sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2 : null;
    records.push({ runId: entry.name, hash, sourceDuration: duration, clips, renderMs: Number(render.elapsedMs ?? 0), totalMs, cost });
    (records[records.length - 1] as any).median = median;
  }
  return records.map((r: any) => { const hours = r.sourceDuration / 3600; return { runId: r.runId, medianDuration: r.median, contextShare: r.clips.length ? r.clips.filter((c: any) => c.needs_context_line).length / r.clips.length : null, costPerHour: r.cost == null ? null : r.cost / hours, renderPerHour: r.renderMs / 1000 / hours, totalPerHour: r.totalMs == null ? null : r.totalMs / 1000 / hours }; });
}
function groupBy<T>(values: T[], keyFn: (value: T) => string): Map<string, T[]> { const map = new Map<string, T[]>(); for (const value of values) { const key = keyFn(value), items = map.get(key) ?? []; items.push(value); map.set(key, items); } return map; }
function mdRatingTable(groups: Map<string, Rating[]>): string { if (!groups.size) return "No ratings yet."; return ["| Group | Usable rate | Sample | 95% Wilson CI |", "|---|---:|---:|---:|", ...[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => { const m = usableRate(values); return `| ${md(name)} | ${pct(m.rate)} | ${m.successes}/${m.n} | ${pct(m.interval[0])}–${pct(m.interval[1])} |`; })].join("\n"); }
function pct(n: number): string { return `${(n * 100).toFixed(1)}%`; }
function md(s: string): string { return s.replaceAll("|", "\\|").replaceAll("\n", " "); }
