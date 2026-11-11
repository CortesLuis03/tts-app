"""API FastAPI + servidor del frontend estático.

El historial vive en el navegador (IndexedDB); el backend solo genera audio.
"""
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import tts

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
MAX_TEXT_CHARS = int(os.getenv("MAX_TEXT_CHARS", "20000"))

app = FastAPI(title="TTS App")


@app.middleware("http")
async def no_cache_static(request, call_next):
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.exception_handler(tts.TTSError)
async def tts_error_handler(_, exc: tts.TTSError):
    return JSONResponse(status_code=exc.status, content={"error": exc.message})


class GenerateRequest(BaseModel):
    text: str
    model: str
    voice: str
    speed: float = Field(1.0)
    instructions: str = ""
    # Solo modelos ElevenLabs
    stability: float | None = Field(None, ge=0, le=1)
    similarity: float | None = Field(None, ge=0, le=1)
    style: float | None = Field(None, ge=0, le=1)
    speaker_boost: bool | None = None
    language: str | None = None


def _has_key() -> bool:
    key = os.getenv("OPENROUTER_API_KEY", "").strip()
    return bool(key) and not key.startswith("sk-or-v1-xxxx")


@app.get("/api/config")
def get_config():
    return {"max_chars": MAX_TEXT_CHARS, "chunk_chars": tts.MAX_CHUNK_CHARS, "has_api_key": _has_key()}


@app.get("/api/models")
def get_models():
    models = tts.fetch_models()
    return {"default": tts.default_model_id(models), "models": models}


@app.post("/api/generate")
def generate(req: GenerateRequest):
    if len(req.text.strip()) > MAX_TEXT_CHARS:
        raise tts.TTSError(f"El texto supera el límite de {MAX_TEXT_CHARS} caracteres.")
    eleven = None
    if req.model.startswith("elevenlabs/"):
        eleven = tts.build_eleven_options(
            stability=req.stability, similarity=req.similarity, style=req.style,
            speaker_boost=req.speaker_boost, language=req.language,
        )
    audio, n_chunks = tts.generate_speech(
        text=req.text, model=req.model, voice=req.voice, speed=req.speed,
        instructions=req.instructions, eleven=eleven,
    )
    return Response(content=audio, media_type="audio/mpeg", headers={"X-Chunks": str(n_chunks)})


@app.get("/api/preview")
def preview(model: str, voice: str):
    return FileResponse(tts.preview_speech(model, voice), media_type="audio/mpeg")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
