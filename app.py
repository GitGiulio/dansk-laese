import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, ValidationError
from python_multipart import create_form_parser
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from documents import MAX_FILE, ImportError as DocumentError, extract_file, import_text
from preparation import Preparation, prepare
from translation import PROMPT_VERSION, Lookup, TranslationError, model_name, translate

ROOT = Path(__file__).resolve().parent
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])


@app.middleware("http")
async def private_local_app(request: Request, call_next):
    origin = request.headers.get("origin")
    if origin and origin != f"{request.url.scheme}://{request.headers.get('host')}":
        response = JSONResponse({"detail": "Only this local reader can make requests."}, status_code=403)
    else:
        response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' https://api.groq.com https://*.supabase.co; "
        "worker-src 'self'; img-src 'self' data: blob:; font-src 'self' blob:; "
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    )
    return response


async def bounded_body(request: Request, limit: int) -> bytes:
    size, chunks = 0, []
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise HTTPException(413, "Request is too large. Limit files to 10 MiB and text to 200,000 characters.")
        chunks.append(chunk)
    return b"".join(chunks)


class TextImport(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    text: str


def upload(body: bytes, content_type: str) -> dict:
    files = []

    def field(_):
        raise DocumentError("Upload one file using the file field.")

    def file(part):
        try:
            if files or part.field_name != b"file":
                raise DocumentError("Upload exactly one file using the file field.")
            part.file_object.seek(0)
            files.append((part.file_name.decode("utf-8", errors="replace"), part.file_object.read()))
        finally:
            part.close()

    # Keep the already-bounded upload in memory, including multipart parser storage.
    parser = create_form_parser({"Content-Type": content_type.encode()}, field, file,
                              config={"MAX_MEMORY_FILE_SIZE": MAX_FILE + 65536, "MAX_FIELDS": 1})
    try:
        parser.write(body)
        parser.finalize()
    finally:
        parser.close()
    if len(files) != 1:
        raise DocumentError("No file was found. Choose a TXT, DOCX or PDF file.")
    return extract_file(*files[0])


@app.get("/api/config")
async def config():
    return {"configured": bool(os.environ.get("GROQ_API_KEY", "").strip()),
            "model": model_name(), "prompt_version": PROMPT_VERSION}


@app.post("/api/import")
async def import_document(request: Request):
    body = await bounded_body(request, MAX_FILE + 65536)
    content_type = request.headers.get("content-type", "")
    try:
        if content_type.startswith("multipart/form-data"):
            return await run_in_threadpool(upload, body, content_type)
        if not content_type.startswith("application/json"):
            raise HTTPException(415, "Paste text as JSON or upload a file.")
        data = TextImport.model_validate_json(body)
        return await run_in_threadpool(import_text, data.text)
    except ValidationError as exc:
        status = 400 if any(e["type"] == "json_invalid" for e in exc.errors()) else 422
        raise HTTPException(status, "Provide a JSON object with a text string.") from exc
    except DocumentError as exc:
        raise HTTPException(400, str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, "Could not read this upload. Choose the file again or paste its text.") from exc


async def translation_response(request: Request, schema, handler):
    body = await bounded_body(request, 65536)
    try:
        lookup = schema.model_validate_json(body)
    except ValidationError as exc:
        raise HTTPException(422, "Use complete words in an excerpt of at most 2,000 characters, at most 60 preparation targets, and English or Italian.") from exc
    try:
        return await handler(lookup)
    except TranslationError as exc:
        headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after else {}
        return JSONResponse({"detail": str(exc)}, status_code=exc.status, headers=headers)


@app.post("/api/translate")
async def lookup_word(request: Request):
    return await translation_response(request, Lookup, translate)


@app.post("/api/prepare")
async def prepare_words(request: Request):
    return await translation_response(request, Preparation, prepare)


@app.get("/")
async def index():
    return RedirectResponse("/static/")


app.mount("/static", StaticFiles(directory=ROOT / "static", html=True), name="static")
