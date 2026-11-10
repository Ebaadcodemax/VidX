"""JSON-lines-free subprocess adapter for local Faster-Whisper transcription."""

import argparse
import json
import sys
import time


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", choices=("cpu", "cuda"), required=True)
    parser.add_argument("--compute-type", required=True)
    parser.add_argument("--cpu-threads", type=int, required=True)
    parser.add_argument("--download-root", required=True)
    parser.add_argument("--language")
    args = parser.parse_args()

    try:
        import ctranslate2
        import faster_whisper
        from faster_whisper import WhisperModel

        started = time.perf_counter()
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
            cpu_threads=args.cpu_threads,
            download_root=args.download_root,
        )
        segments, info = model.transcribe(
            args.audio,
            language=args.language,
            beam_size=5,
            word_timestamps=True,
            vad_filter=True,
        )

        output_segments = []
        omitted_words = 0
        for segment in segments:
            output_words = []
            for word in segment.words or []:
                if word.start is None or word.end is None:
                    raise RuntimeError("Faster-Whisper returned a word without timestamps; refusing to invent timing")
                if float(word.end) <= float(word.start):
                    omitted_words += 1
                    continue
                output_words.append({
                    "text": word.word.strip(),
                    "startSeconds": float(word.start),
                    "endSeconds": float(word.end),
                    "confidence": float(word.probability) if word.probability is not None else None,
                })
            output_segments.append({
                "startSeconds": float(segment.start),
                "endSeconds": float(segment.end),
                "text": segment.text.strip(),
                "words": output_words,
            })

        result = {
            "language": info.language,
            "languageProbability": float(info.language_probability) if info.language_probability is not None else None,
            "segments": output_segments,
            "omittedWordsWithoutPositiveDuration": omitted_words,
            "versions": {"fasterWhisper": faster_whisper.__version__, "ctranslate2": ctranslate2.__version__},
            "elapsedMs": round((time.perf_counter() - started) * 1000),
        }
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:  # Keep stack traces out of ordinary CLI output.
        sys.stderr.write(f"Local transcription failed: {type(error).__name__}: {error}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
