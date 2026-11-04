import asyncio
import json

import httpx
import pytest
from pydantic import ValidationError

from preparation import Preparation, prepare
from translation import TranslationError


def response(entries):
    return {"entries": entries}


def entry(ids, text="meaning"):
    return {"word_ids": ids, "translation": text, "uncertain": False}


def run(monkeypatch, answers, request=None):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    seen=[]
    def handler(req):
        seen.append(json.loads(req.content))
        answer=answers[min(len(seen)-1,len(answers)-1)]
        if isinstance(answer,httpx.Response):return answer
        return httpx.Response(200,json={"choices":[{"message":{"content":json.dumps(answer)}}],"usage":{"total_tokens":800}})
    async def execute():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await prepare(request or Preparation(context="Det er lige meget.",start=0,end=17,language="en"),client)
    return execute,seen


def test_prepares_words_and_expression_with_full_coverage(monkeypatch):
    execute,seen=run(monkeypatch,[response([entry([0],"that"),entry([1],"is"),entry([2,3],"doesn't matter")])])
    result=asyncio.run(execute())
    assert len(result["entries"]) == 3
    assert result["entries"][2]["highlights"] == [{"start":7,"end":11},{"start":12,"end":17}]
    assert result["next_request_ms"] >= 6000
    payload=json.loads(seen[0]["messages"][1]["content"])
    assert payload["words"] == [{"id":0,"text":"Det"},{"id":1,"text":"er"},{"id":2,"text":"lige"},{"id":3,"text":"meget"}]
    assert payload["target_word_ids"] == [0,1,2,3]


@pytest.mark.parametrize("bad", [response([entry([0])]),response([entry([0,1]),entry([1,2,3])]),response([entry([0,1,2,99])]),response([entry([0,1,2,3],"")]),response([entry([3,2,1,0])])])
def test_incomplete_or_invalid_coverage_gets_one_retry(monkeypatch,bad):
    execute,seen=run(monkeypatch,[bad,response([entry([0,1,2,3])])])
    assert asyncio.run(execute())["entries"]
    assert len(seen) == 2


def test_incomplete_coverage_fails_after_corrective_retry(monkeypatch):
    execute,seen=run(monkeypatch,[response([entry([0])])])
    with pytest.raises(TranslationError,match="complete"):
        asyncio.run(execute())
    assert len(seen)==2


def test_separated_expression_can_include_a_word_outside_target_chunk(monkeypatch):
    request=Preparation(context="Hun slog ordet op.",start=4,end=8,language="it")
    execute,_=run(monkeypatch,[response([entry([1,3],"ha cercato")])],request)
    result=asyncio.run(execute())
    assert result["entries"][0]["highlights"] == [{"start":4,"end":8},{"start":15,"end":17}]


def test_preparation_caps_target_words():
    context=" ".join(["a"]*61)
    with pytest.raises(ValidationError):
        Preparation(context=context,start=0,end=len(context),language="en")


def test_rate_limit_does_not_retry(monkeypatch):
    execute,seen=run(monkeypatch,[httpx.Response(429,headers={"retry-after":"12"})])
    with pytest.raises(TranslationError) as error:
        asyncio.run(execute())
    assert error.value.retry_after==12
    assert len(seen)==1


def test_provider_schema_rejection_gets_one_retry(monkeypatch):
    rejected=httpx.Response(400,json={"error":{"code":"json_validate_failed","failed_generation":"PRIVATE DOCUMENT FRAGMENT"}})
    execute,seen=run(monkeypatch,[rejected,response([entry([0,1,2,3])])])
    result=asyncio.run(execute())
    assert len(seen)==2
    assert result["next_request_ms"]>=33000
    assert "PRIVATE DOCUMENT FRAGMENT" not in json.dumps(seen)
    assert "nonempty" in seen[1]["messages"][-1]["content"]
    assert "minLength" not in json.dumps(seen[0]["response_format"]["json_schema"]["schema"])


def test_persistent_provider_schema_rejection_stops_after_one_retry(monkeypatch):
    execute,seen=run(monkeypatch,[httpx.Response(400,json={"error":{"code":"json_validate_failed"}})])
    with pytest.raises(TranslationError,match="corrective retry"):
        asyncio.run(execute())
    assert len(seen)==2
