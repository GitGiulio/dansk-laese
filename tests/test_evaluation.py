import json
import subprocess
import sys

from evaluate import CASES, case_lookup


def test_all_curated_cases_have_valid_targets_and_both_languages():
    cases = json.loads(CASES.read_text(encoding="utf-8"))
    assert len(cases) == 12
    assert len({case["id"] for case in cases}) == 12
    for case in cases:
        for language in ("en", "it"):
            lookup = case_lookup(case, language)
            assert lookup.context[lookup.start:lookup.end] == case["target"]
            assert case["expected"][language]


def test_evaluation_requires_explicit_opt_in():
    result = subprocess.run([sys.executable, "evaluate.py"], capture_output=True, text=True)
    assert result.returncode == 0
    assert "No network calls" in result.stdout
