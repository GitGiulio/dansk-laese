import pytest
from fastapi.testclient import TestClient

import app as server
from translation import TranslationError


@pytest.fixture
def client():
    return TestClient(server.app, base_url="http://127.0.0.1:8000")


def test_paste_and_preview_reimport(client):
    response = client.post("/api/import", json={"text": "Hej verden.\n\nÆbler og øer."})
    assert response.status_code == 200
    assert len(response.json()["paragraphs"]) == 2
    assert response.headers["cache-control"] == "no-store"
    edited = client.post("/api/import", json={"text": "Rettet tekst."})
    assert edited.json()["text"] == "Rettet tekst."


def test_upload(client):
    result = client.post("/api/import", files={"file": ("tekst.txt", "Rødgrød med fløde.".encode())})
    assert result.status_code == 200
    assert result.json()["text"] == "Rødgrød med fløde."


@pytest.mark.parametrize("body,status", [({"text": ""}, 400), ({"text": "x" * 200001}, 400), ({"text": 123}, 422), ({"extra": 1}, 422)])
def test_bad_import(client, body, status):
    assert client.post("/api/import", json=body).status_code == status


def test_body_limits(client):
    assert client.post("/api/import", content=b"x" * (10 * 1024 * 1024 + 65537)).status_code == 413
    assert client.post("/api/translate", content=b"x" * 65537).status_code == 413


def test_malformed_requests(client):
    assert client.post("/api/import", content=b"{", headers={"content-type": "application/json"}).status_code == 400
    assert client.post("/api/import", content=b"bad", headers={"content-type": "multipart/form-data; boundary=x"}).status_code == 400
    assert client.post("/api/translate", json={"context": "Hej", "start": 1, "end": 2, "language": "en"}).status_code == 422


def test_missing_key_and_config(client, monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    config = client.get("/api/config").json()
    assert config["configured"] is False
    assert config["model"] == "openai/gpt-oss-120b"
    response = client.post("/api/translate", json={"context": "Hej", "start": 0, "end": 3, "language": "en"})
    assert response.status_code == 503
    assert "GROQ_API_KEY" in response.json()["detail"]


def test_translation_and_cooldown_contract(client, monkeypatch):
    async def fake_lookup(lookup):
        assert lookup.language == "it"
        raise TranslationError("Free limit reached", 429, 12)

    monkeypatch.setattr(server, "translate", fake_lookup)
    response = client.post("/api/translate", json={"context": "Hej", "start": 0, "end": 3, "language": "it"})
    assert response.status_code == 429
    assert response.headers["retry-after"] == "12"


def test_preparation_endpoint_validates_and_forwards_chunks(client,monkeypatch):
    async def fake_prepare(request):
        assert request.context == "Hej du"
        assert request.language == "it"
        return {"entries":[],"next_request_ms":0}
    monkeypatch.setattr(server,"prepare",fake_prepare)
    response=client.post("/api/prepare",json={"context":"Hej du","start":0,"end":6,"language":"it"})
    assert response.status_code==200
    assert response.json()["next_request_ms"]==0
    context=" ".join(["a"]*61)
    assert client.post("/api/prepare",json={"context":context,"start":0,"end":len(context),"language":"en"}).status_code==422
    assert client.post("/api/prepare",content=b"x"*65537).status_code==413


def test_other_origins_and_hosts_cannot_spend_key(client):
    assert client.post("/api/import", json={"text": "Hej"}, headers={"origin": "https://example.com"}).status_code == 403
    assert client.get("/", headers={"host": "attacker.example"}).status_code == 400
    assert client.post("/api/import", json={"text": "Hej"}, headers={"origin": "http://127.0.0.1:8000"}).status_code == 200


def test_page_and_no_store(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "Dansk" in response.text
    assert response.headers["cache-control"] == "no-store"
    assert "script-src 'self'" in response.headers["content-security-policy"]
