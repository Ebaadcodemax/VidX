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
| FFmpeg/FFprobe | Local media probe and audio extraction | System-installed build; inspect its build configuration. FFmpeg is LGPL by default and includes optional GPL components. The available local Gyan build reports `libx264`; this is acceptable for local pilot use per the build brief, but review the exact build and codec obligations before distributing a bundled product. Do not redistribute this system binary from this project. |

No paid dependency or hosted service is used by M1. Model provider pricing is not configured; do not guess rates. Add reviewed provider/model rates to `config.yaml` only after founder approval.
