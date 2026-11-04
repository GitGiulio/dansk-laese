"""Opt-in Groq evaluation. Saves model answers for human language review."""
import argparse
import asyncio
import json
import os
from pathlib import Path

from translation import Lookup, TranslationError, model_name, translate

CASES = Path(__file__).parent / "evaluation" / "cases.json"


def case_lookup(case: dict, language: str) -> Lookup:
    start = -1
    for _ in range(case.get("occurrence", 0) + 1):
        start = case["context"].index(case["target"], start + 1)
    return Lookup(context=case["context"], start=start,
                  end=start + len(case["target"]), language=language)


async def evaluate(output: Path, interval: float) -> int:
    cases = json.loads(CASES.read_text(encoding="utf-8"))
    results = []
    for number, (case, language) in enumerate((c, lang) for c in cases for lang in ("en", "it")):
        if number:
            await asyncio.sleep(interval)
        row = {"id": case["id"], "language": language, "context": case["context"],
               "target": case["target"], "expected_meaning": case["expected"][language],
               "expected_expression": case["expression"], "meaning_acceptable": None,
               "expression_acceptable": None, "review_notes": ""}
        try:
            row["answer"] = await translate(case_lookup(case, language))
            print(f"{number + 1}/24 {case['id']} ({language}): answer recorded")
        except TranslationError as exc:
            row["error"] = str(exc)
            print(f"{number + 1}/24 {case['id']} ({language}): {exc}")
        results.append(row)
        output.write_text(json.dumps({"model": model_name(), "linguistic_accuracy_verified": False,
                                     "review_required": True, "results": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved {len(results)} results to {output}. Review meanings and source expressions manually.")
    print("Software checks do not establish linguistic accuracy. No provider or model was changed.")
    return 1 if any("error" in row for row in results) else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="Explicitly send the 24 curated lookups to Groq")
    parser.add_argument("--output", type=Path, default=Path("evaluation-results.json"))
    parser.add_argument("--interval", type=float, default=15, help="Seconds between lookups; default 15 to reduce quota pressure")
    args = parser.parse_args()
    if not args.live:
        print("No network calls made. Use --live to run the 24-case evaluation.")
        return 0
    if not os.environ.get("GROQ_API_KEY", "").strip():
        print("Live evaluation was not run: set GROQ_API_KEY first. Translation quality remains unverified.")
        return 2
    if args.interval < 0:
        parser.error("--interval must be nonnegative")
    return asyncio.run(evaluate(args.output, args.interval))


if __name__ == "__main__":
    raise SystemExit(main())
