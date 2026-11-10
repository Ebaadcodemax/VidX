# Dependency and media-tool license notes

These are planning notes for the local v0 pilot, not legal advice. Recheck the
resolved package licenses before distribution; lockfile versions are the exact
installed versions for this checkout.

| Component | Purpose | License note |
| --- | --- | --- |
| commander | CLI argument parsing | MIT |
| dotenv | Local environment loading | BSD-2-Clause |
| yaml | YAML config parsing | ISC |
| zod | Runtime schema validation | MIT |
| TypeScript | Type checking | Apache-2.0 |
| @types/node | Node.js declarations | MIT |
| Vitest | Test runner | MIT |
| tsx | Local TypeScript runner | MIT |
| faster-whisper 1.2.1 | Local speech-to-text model runtime | MIT; local inference only |
| ctranslate2 4.8.5 | Local optimized inference | MIT |
| av 15.1.0 | Audio decoding used by Faster-Whisper | BSD-3-Clause |
| Gemini API | Optional hosted speech transcription | Google service terms apply. Gemini is not an installed dependency. Audio is uploaded only when all explicit environment gates are true; review current terms, retention, privacy, and pricing before enabling. |
| FFmpeg/FFprobe | Local media probe and audio extraction | System-installed build; inspect its build configuration. FFmpeg is LGPL by default and includes optional GPL components. The available local Gyan build reports `libx264`; this is acceptable for local pilot use per the build brief, but review the exact build and codec obligations before distributing a bundled product. Do not redistribute this system binary from this project. |
| Nirmala UI (Windows; verified on this machine) | Local ASS caption rendering, including Latin and Devanagari glyphs | System-installed font; this project does not bundle or redistribute it. Review applicable font terms before redistribution or bundling. The renderer currently assumes this Windows font directory. |

M2 transcription and M4 FFmpeg rendering add no paid package dependency. Local Faster-Whisper inference and FFmpeg rendering have no per-call provider charge (hardware, energy, model downloads and processing time still have costs). Gemini is optional and uses a conservative configured standard-tier estimate for spend protection; the estimate is not a billing assertion, and the app cannot verify that the Google project is limited to its free tier. Do not enable hosted transcription until the creator has consented and data-use terms have been reviewed.
