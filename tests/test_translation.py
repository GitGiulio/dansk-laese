import asyncio
import json

import httpx
import pytest

from translation import Lookup, TranslationError, translate


def run_lookup(monkeypatch, replies, lookup=None):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        item = replies[min(len(seen) - 1, len(replies) - 1)]
        if isinstance(item, Exception):
            raise item
        if isinstance(item, httpx.Response):
            return item
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(item)}}]})

    async def execute():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await translate(lookup or Lookup(context="Det er lige meget.", start=7, end=11, language="en"), client)

    return execute, seen


def answer(ids=(2, 3), **changes):
    return {"word_ids": list(ids), "translation": "It doesn't matter", "explanation": "An expression of indifference.", "uncertain": False, **changes}


def test_expands_hover_to_expression(monkeypatch):
    execute, seen = run_lookup(monkeypatch, [answer()])
    result = asyncio.run(execute())
    assert result["translation"] == "It doesn't matter"
    assert result["source_text"] == "lige meget"
    assert result["highlights"] == [{"start": 7, "end": 11}, {"start": 12, "end": 17}]
    assert seen[0]["model"] == "openai/gpt-oss-120b"


def test_provider_schema_rejection_retries_without_reusing_failed_generation(monkeypatch):
    execute,seen=run_lookup(monkeypatch,[httpx.Response(400,json={"error":{"code":"json_validate_failed","failed_generation":"PRIVATE FRAGMENT"}}),answer()])
    assert asyncio.run(execute())["translation"]=="It doesn't matter"
    assert len(seen)==2
    assert "PRIVATE FRAGMENT" not in json.dumps(seen)
    assert "minLength" not in json.dumps(seen[0]["response_format"]["json_schema"]["schema"])
    assert seen[0]["response_format"]["json_schema"]["strict"] is True
    payload = json.loads(seen[0]["messages"][1]["content"])
    assert payload["target_word_ids"] == [2]


def test_repeated_word_and_unicode_are_exact(monkeypatch):
    context = "😀 Åse så en så."
    lookup = Lookup(context=context, start=12, end=14, language="it")
    execute, seen = run_lookup(monkeypatch, [answer((3,), translation="una scrofa")], lookup)
    result = asyncio.run(execute())
    assert result["highlights"] == [{"start": 12, "end": 14}]
    assert json.loads(seen[0]["messages"][1]["content"])["language"] == "Italian"


def test_discontiguous_expression(monkeypatch):
    lookup = Lookup(context="Hun slog ordet op.", start=4, end=8, language="en")
    execute, _ = run_lookup(monkeypatch, [answer((1, 3), translation="looked up")], lookup)
    assert asyncio.run(execute())["source_text"] == "slog … op"


@pytest.mark.parametrize("count", [201, 1000])
def test_long_valid_selection_can_return_all_source_words(monkeypatch, count):
    context = " ".join(["a"] * count)
    lookup = Lookup(context=context, start=0, end=len(context), language="en")
    execute, seen = run_lookup(monkeypatch, [answer(range(count), translation="a selected passage")], lookup)
    result = asyncio.run(execute())
    assert len(result["highlights"]) == count
    assert seen[0]["max_completion_tokens"] >= 4 * count


@pytest.mark.parametrize("bad", [answer((99,)), answer((0,)), answer(translation=""), answer((2, 2)), answer(uncertain="yes")])
def test_invalid_model_answer_gets_one_corrective_retry(monkeypatch, bad):
    execute, seen = run_lookup(monkeypatch, [bad, answer()])
    assert asyncio.run(execute())["translation"] == "It doesn't matter"
    assert len(seen) == 2


def test_invalid_model_answer_fails_after_two_attempts(monkeypatch):
    execute, seen = run_lookup(monkeypatch, [answer((99,))])
    with pytest.raises(TranslationError, match="valid translation"):
        asyncio.run(execute())
    assert len(seen) == 2


@pytest.mark.parametrize("status,expected", [(401, "API key"), (429, "limit"), (500, "unavailable")])
def test_provider_errors_are_actionable(monkeypatch, status, expected):
    execute, seen = run_lookup(monkeypatch, [httpx.Response(status, headers={"retry-after": "12"})])
    with pytest.raises(TranslationError, match=expected) as err:
        asyncio.run(execute())
    assert len(seen) == 1
    if status == 429:
        assert err.value.retry_after == 12


def test_timeout_does_not_retry(monkeypatch):
    execute, seen = run_lookup(monkeypatch, [httpx.ReadTimeout("timeout")])
    with pytest.raises(TranslationError, match="timed out"):
        asyncio.run(execute())
    assert len(seen) == 1


def test_missing_key(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    with pytest.raises(TranslationError, match="GROQ_API_KEY"):
        asyncio.run(translate(Lookup(context="Hej", start=0, end=3, language="en")))


@pytest.mark.parametrize("changes", [dict(context="x" * 2001), dict(start=-1), dict(end=99), dict(language="de"), dict(start=1, end=2), dict(start=3, end=4)])
def test_lookup_rejects_bad_boundaries(changes):
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        Lookup(**({"context": "Hej du", "start": 0, "end": 3, "language": "en"} | changes))
