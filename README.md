# vclip (pilot CLI)

A small local pipeline for creator-provided media: ingestion, transcription, clip planning, rendering, and offline review/evaluation. It does not access YouTube/Instagram or provide a manual timeline editor.

## Requirements

- Node.js 22.18 or later and npm
- FFmpeg and FFprobe available on `PATH`
- Python 3.13 for optional local Faster-Whisper transcription

Local processing requires no API key or paid service. Hosted Gemini transcription is optional and guarded by creator consent, an acknowledgement of unpaid-tier data use, a free-tier-only confirmation, and the configured per-run cost cap.

## Setup

```powershell
npm install
npm run cli -- init
```

`init` checks Node, FFmpeg, FFprobe, and any environment variable names explicitly listed in `config.yaml`. Never put real keys in source control; `.env` is ignored.

## Run media probing (M1)

```powershell
npm run cli -- run "C:\path\to\your\video.mp4"
```

The command creates a new directory beneath `runs/` with:

- `manifest.json`: source filename/hash, FFprobe metadata, stage timings, and tool versions.
- `audio.wav`: mono 16 kHz PCM audio for a later transcription stage.
- `cost.json`: provider-call estimate and local processing timing. M1 makes no provider calls, so provider cost is zero; local compute time is recorded but not priced.

Use `--out <new-directory>` to choose an output directory. The command refuses to overwrite an existing directory. On failure, it writes `failure.json` when possible.

```powershell
npm run cli -- cost "runs\<run-directory>"
```

## Transcription (M2)

Create the Python environment and install the pinned open-source local packages:

```powershell
py -3.13 -m venv .venv-asr
.\.venv-asr\Scripts\python.exe -m pip install -r requirements-local-asr.txt
```

The first local run downloads the configured Faster-Whisper model to `transcription.local.downloadDirectory` in `config.yaml`. Default is `small` on CPU `int8`; there is no speaker diarization in this adapter.

```powershell
npm run cli -- transcribe "C:\path\to\clip.mp4" --provider faster-whisper
npm run cli -- compare-asr "C:\path\to\clip.mp4"
```

`transcribe` saves `transcript.json` under a new run directory. `compare-asr` writes provider transcripts under `transcripts/<provider>/transcript.json`, plus `comparison.json` and `cost.json`. Providers run sequentially on the same normalized audio. Each record includes provider/model, elapsed time, usage and estimated cost. A provider may be marked skipped or failed; the comparison file does not assert accuracy. Use a human-checked reference transcript to calculate accuracy metrics.

To enable Gemini, add its key to ignored `.env`, then set `GEMINI_CREATOR_CONSENT=true`, `GEMINI_UNPAID_DATA_USE_ACK=true`, and `GEMINI_FREE_TIER_ONLY=true` only after reviewing the data-use terms and confirming the Google project is configured for free-tier usage. The app cannot verify Google billing settings. Gemini uploads normalized audio to Google, requests word timestamps and speaker labels, asks not to store interaction state, and deletes the uploaded file after processing. Timestamped diarization requests are limited to 30 minutes. The configured standard-tier rate is a conservative cap estimate, not a claim of actual charges; no paid-tier call is intentionally requested. Do not send private media unless you have authority and informed consent.

Both adapters return a shared validated transcript schema. Word timestamps are preserved; unsupported speaker labels are explicitly marked unavailable. Words with invalid timing are omitted with a warning rather than assigned fabricated timestamps.

## Clip planning (M3; no rendering)

```powershell
npm run cli -- plan "C:\vclip-data\runs\my-transcription\transcript.json" --out "C:\vclip-data\runs\my-plan"
```

For a one-run fallback to a different reviewed model, pass `--model <model-id>`. The ID must have a price entry in `config.yaml`; the run record stores why the override was selected. The configured default is not changed.

This sends timestamped transcript text to the configured Gemini reasoner; M3 does not upload video or audio and does not render clips. It proposes versioned `edit-ir/0.1` candidates, runs a separate critic pass, and then validates and snaps boundaries in local code. Versioned prompts live in `src/prompts/`. Each output directory contains the validated `proposal.json`, complete `critic.json`, accepted `edit_ir.json`, `rejected-candidates.json` (including each rejected candidate and its critic verdict), `cost.json`, and `planning.json` (or `failure.json` plus cost records if planning fails). The planner refuses output inside the project directory and refuses to overwrite an existing run.

The reasoner uses the same three Gemini consent/free-tier flags as transcription. It calls Google's Interactions API with structured JSON output and `store: false`; the run record includes the endpoint and selected model. Configured standard-tier token rates are used conservatively for reservation against the `$0.05` run cap; `MAX_RUN_COST_USD` in `.env` can lower, but cannot raise, that configured cap. Exact prompt token counts are obtained before generation. Transient HTTP 429/503 responses retry with bounded exponential backoff; every attempt is cost-reserved and recorded in `cost.json`. Google documents 5xx failures as unbilled; their held reservation is released after the failure response, while 429 and uncertain failures remain reserved. Malformed or semantically invalid output gets one repair attempt. Candidates still invalid after that are logged and skipped. Every accepted clip is checked locally for bounds, duration, overlaps, scores and required fields, then snapped to sentence/word boundaries with configured end padding.

The default model remains `gemini-3.8-flash`. If it returns repeated capacity errors, a one-run override such as `--model gemini-3.6-flash` is allowed only when that model has a configured price. The selected model and reason are written to `planning.json`; the default setting is not changed.

## Rendering (M4)

Render only from the original source video, validated M3 `edit_ir.json`, and its matching M2 `transcript.json`:

```powershell
npm run cli -- render "C:\vclip-data\sample5min.mp4" "C:\vclip-data\runs\my-plan\edit_ir.json" "C:\vclip-data\runs\my-transcription\transcript.json" --out "C:\vclip-data\runs\my-render"
```

Before rendering, vclip validates the Edit IR and transcript and checks that both source hashes and durations match the supplied video. Output is one MP4 per accepted clip under `clips/`, with matching ASS caption files. FFmpeg applies a centered 9:16 crop, burns captions using transcript word times, and encodes H.264 video with AAC audio. It does not track faces. FFprobe verifies H.264, 1080x1920 square-pixel output, AAC, and duration within 0.35 seconds.

Each render directory contains `render.json`, `cost.json`, and `ffmpeg-commands.jsonl`. If a command or output check fails, vclip writes `failure.json` and `ffmpeg-partial.log` and preserves completed clips and command records. Local FFmpeg has no paid service charge; CPU time and electricity are not priced. Rendering uses a fixed encoder configuration and strips source metadata to keep identical inputs and settings byte-for-byte deterministic on the same FFmpeg build.

This Windows setup uses the installed Nirmala UI system font, which covers Latin and Devanagari; the project does not bundle the font. Rendering is currently configured and tested on Windows; other operating systems need a platform-specific font path and family configuration before rendering.

## Offline review and evaluation (M5)

All review and evaluation data should stay outside the repository. Defaults use `C:\vclip-data`:

```powershell
npm run cli -- review "C:\vclip-data\runs\my-render" --edit-ir "C:\vclip-data\runs\my-plan\edit_ir.json" --transcript "C:\vclip-data\runs\my-transcription\transcript.json"
npm run cli -- eval
npm run cli -- purge "creator-or-run-id" --dry-run
```

`review.html` is a static offline page with relative rendered-clip paths. Keep the `clips/` folder with it when sharing or zipping. It does not embed the source video. The page downloads ratings as `ratings.csv`; `review.csv` is a blank plain-CSV fallback. Put completed rating CSVs in `C:\vclip-data\eval` and run `eval`; the Markdown report is written to `C:\vclip-data\eval\report.md`. Ratings include per-run and per-rater usable rates, sample sizes, and 95% Wilson intervals. Fewer than 20 ratings are explicitly marked as a small, directional sample. Production metrics are computed only when matching local run metadata exists.

Blind comparisons use `review <render-run> --compare <competitor-folder>`. The folder must contain the same number of video clips as the run. Share only the generated `blind-review/` folder: both clips are copied under opaque asset names and shown as A/B in randomized order. The mapping is stored as `C:\vclip-data\blind-keys\<run-id>\key.json`, outside the shared folder; the sheet and answers use an opaque comparison ID. A/B answers download separately as `ab_ratings.csv`.

`purge <creator-or-run>` first shows a dry-run with `--dry-run`; without it, the command asks for the exact confirmation word `DELETE`. It removes matching run folders and rows associated with those run IDs from evaluation CSVs, then appends a content-free audit record under `C:\vclip-data\audit`. Creator matching uses run-name prefixes or creator identifiers explicitly present in local run metadata. M5 makes no provider calls and processes no media/transcript with an external service.

## Config and cost accounting

`config.yaml` sets a low default run cap and stores reviewed Gemini standard-tier estimates for transcription and reasoning. The default cap is `$0.05` per run. Hosted transcription preflights its estimate before audio upload; clip planning reserves estimated token cost before each model call. Local CPU time is reported but priced at zero. Update rates after checking current provider prices; cost estimates are not invoices.

## Development checks

```powershell
npm run build
npm test
```

Tests create a short synthetic video with FFmpeg in a temporary directory; they do not require or upload creator footage. Fixture provenance requirements are in `fixtures/LICENSES.md`; dependency and FFmpeg notes are in `docs/LICENSES-NOTES.md`.

## Current boundary

This local CLI covers probing, transcription, clip proposal and criticism, validation, boundary snapping, captioned clip rendering, and local review/evaluation. It does not implement Creator DNA, access social platforms, generate visuals, provide a manual timeline editor, or run as a hosted service. Use only media you own or have written permission to process.
