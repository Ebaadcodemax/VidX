# vclip (pilot CLI)

A small local pipeline for testing whether AI-selected short clips are useful to creators. M1 only probes a creator-provided file and extracts normalized audio. It does not call any model provider, upload media, or access YouTube/Instagram.

## Requirements

- Node.js 22.18 or later and npm
- FFmpeg and FFprobe available on `PATH`

No API key or paid service is needed for M1.

## Setup

```powershell
npm install
npm run cli -- init
```

`init` checks Node, FFmpeg, FFprobe, and any environment variable names explicitly listed in `config.yaml`. Never put real keys in source control; `.env` is ignored.

## Run the local M1 pipeline

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

## Config and cost accounting

`config.yaml` sets a low default run cap and stores reviewed per-model prices. Provider pricing is intentionally empty until a provider is selected and its current prices are verified. Cost math fails closed if a usage type has no configured rate. The cap is `runtime.maxRunCostUsd`.

## Development checks

```powershell
npm run build
npm test
```

Tests create a short synthetic video with FFmpeg in a temporary directory; they do not require or upload creator footage. Fixture provenance requirements are in `fixtures/LICENSES.md`; dependency and FFmpeg notes are in `docs/LICENSES-NOTES.md`.

## Current boundary

This is not the web application and does not implement transcription, Creator DNA, clip selection, rendering, platform integrations, visual generation, a timeline, or a hosted service. Those require separate milestones and approval. Use only media you own or have written permission to process.
