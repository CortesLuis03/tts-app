"""Lógica de OpenRouter: modelos, división de texto y generación de audio."""
import json
import os
import re
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv
from openai import APIConnectionError, APIStatusError, OpenAI

load_dotenv()

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
PREFERRED_MODEL = os.getenv("MODELO_POR_DEFECTO", "elevenlabs/eleven-multilingual-v2")
MAX_CHUNK_CHARS = 3000
MODELS_TTL = 600  # segundos de caché de la lista de modelos

PREVIEW_DIR = Path(__file__).resolve().parent.parent / "previews"
PREVIEW_TEXT = "Hola, así suena mi voz. Puedo leer tus textos en español con claridad y naturalidad."

_models_cache: dict = {"at": 0.0, "data": []}


class TTSError(Exception):
    """Error legible para mostrar al usuario."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


# --------------------------------------------------------------------------
# Cliente
# --------------------------------------------------------------------------
def _client() -> OpenAI:
    key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if not key or key.startswith("sk-or-v1-xxxx"):
        raise TTSError(
            "Falta la API key de OpenRouter. Define OPENROUTER_API_KEY en el archivo .env "
            "y reinicia el servidor.",
            status=500,
        )
    return OpenAI(api_key=key, base_url=OPENROUTER_BASE_URL, timeout=120.0)


# --------------------------------------------------------------------------
# Modelos
# --------------------------------------------------------------------------
def fetch_models(force: bool = False) -> list[dict]:
    """Lista los modelos de voz de OpenRouter (con caché corta)."""
    if not force and _models_cache["data"] and time.time() - _models_cache["at"] < MODELS_TTL:
        return _models_cache["data"]
    try:
        r = httpx.get(
            f"{OPENROUTER_BASE_URL}/models",
            params={"output_modalities": "speech"},
            timeout=20.0,
        )
        r.raise_for_status()
        raw = r.json().get("data", [])
    except (httpx.HTTPError, ValueError) as exc:
        if _models_cache["data"]:
            return _models_cache["data"]  # sirve la caché vieja si OpenRouter falla
        raise TTSError(f"No se pudo obtener la lista de modelos de OpenRouter: {exc}", 502)

    models = []
    for m in raw:
        pricing = m.get("pricing") or {}
        models.append(
            {
                "id": m["id"],
                "name": m.get("name") or m["id"],
                "voices": m.get("supported_voices") or [],
                "supported_parameters": m.get("supported_parameters") or [],
                "free": pricing.get("prompt") == "0" and pricing.get("completion") == "0",
            }
        )
    models.sort(key=lambda m: not m["id"].startswith("elevenlabs/"))  # ElevenLabs primero
    _models_cache.update(at=time.time(), data=models)
    return models


def default_model_id(models: list[dict]) -> str | None:
    """El modelo preferido si existe; si no, el primero con voces; si no, el primero."""
    ids = {m["id"] for m in models}
    if PREFERRED_MODEL in ids:
        return PREFERRED_MODEL
    for m in models:
        if m["voices"]:
            return m["id"]
    return models[0]["id"] if models else None


# --------------------------------------------------------------------------
# División de texto
# --------------------------------------------------------------------------
_SENTENCE_RE = re.compile(r"[^.!?¡¿…\n]*[.!?…]+[\"'”’)\]]*\s*|[^.!?…]+$", re.S)


def split_text(text: str, max_chars: int = MAX_CHUNK_CHARS) -> list[str]:
    """Divide por oraciones en fragmentos de <= max_chars, sin cortar oraciones
    salvo que una sola supere el límite (entonces se corta por palabras)."""
    text = text.strip()
    if len(text) <= max_chars:
        return [text]

    pieces: list[str] = []
    for sentence in _SENTENCE_RE.findall(text):
        while len(sentence) > max_chars:
            cut = sentence.rfind(" ", 0, max_chars)
            cut = cut if cut > 0 else max_chars
            pieces.append(sentence[:cut])
            sentence = sentence[cut:]
        if sentence:
            pieces.append(sentence)

    chunks: list[str] = []
    current = ""
    for p in pieces:
        if current and len(current) + len(p) > max_chars:
            chunks.append(current.strip())
            current = ""
        current += p
    if current.strip():
        chunks.append(current.strip())
    return [c for c in chunks if c]


# --------------------------------------------------------------------------
# Errores de la API
# --------------------------------------------------------------------------
def _api_error_message(exc: APIStatusError) -> tuple[str, int]:
    detail = ""
    try:
        body = exc.response.json()
        err = body.get("error", body)
        detail = err.get("message", "") if isinstance(err, dict) else str(err)
        raw = err.get("metadata", {}).get("raw") if isinstance(err, dict) else None
        if raw:
            detail = f"{detail} ({raw})" if detail else str(raw)
    except (ValueError, AttributeError, json.JSONDecodeError):
        detail = exc.response.text[:300] if exc.response is not None else ""

    code = exc.status_code
    if code == 401:
        return ("La API key de OpenRouter no es válida o fue revocada. Revisa OPENROUTER_API_KEY en .env.", 401)
    if code == 402:
        return ("Sin saldo en OpenRouter. Agrega créditos en https://openrouter.ai/credits e inténtalo de nuevo.", 402)
    if code == 429:
        return ("Demasiadas solicitudes a OpenRouter. Espera un momento e inténtalo otra vez.", 429)
    if code in (400, 404, 422):
        return (f"Solicitud rechazada (modelo, voz o parámetros inválidos): {detail or 'sin detalle'}", 400)
    return (f"Error de OpenRouter ({code}): {detail or 'sin detalle'}", 502)


# --------------------------------------------------------------------------
# Generación
# --------------------------------------------------------------------------
def synthesize_chunk(client: OpenAI, *, model, voice, text, speed, instructions, eleven=None) -> bytes:
    kwargs = dict(model=model, voice=voice, input=text, response_format="mp3")
    if speed is not None and abs(speed - 1.0) > 1e-9:
        kwargs["speed"] = speed
    if instructions:
        # No es un parámetro estándar de OpenAI en todos los modelos; se envía en el cuerpo.
        kwargs["extra_body"] = {"instructions": instructions}
    if eleven:
        # Ajustes de ElevenLabs vía passthrough de OpenRouter (provider.options.elevenlabs)
        kwargs["extra_body"] = {
            **kwargs.get("extra_body", {}),
            "provider": {"options": {"elevenlabs": eleven}},
        }
    try:
        response = client.audio.speech.create(**kwargs)
        audio = response.read()
    except APIStatusError as exc:
        msg, status = _api_error_message(exc)
        raise TTSError(msg, status)
    except APIConnectionError:
        raise TTSError("No se pudo conectar con OpenRouter. Revisa tu conexión a internet.", 502)
    if not audio:
        raise TTSError("OpenRouter devolvió una respuesta de audio vacía.", 502)
    return audio


def generate_speech(*, text, model, voice, speed=1.0, instructions="", eleven=None) -> tuple[bytes, int]:
    """Genera el MP3 completo. Devuelve (audio, número_de_fragmentos)."""
    text = (text or "").strip()
    if not text:
        raise TTSError("El texto está vacío.")
    if not model:
        raise TTSError("Selecciona un modelo.")
    if not voice:
        raise TTSError("Selecciona o escribe una voz.")
    if not 0.25 <= speed <= 4.0:
        raise TTSError("La velocidad debe estar entre 0.25 y 4.0.")

    models = fetch_models()
    match = next((m for m in models if m["id"] == model), None)
    if match is None:
        raise TTSError(f"El modelo '{model}' no existe entre los modelos de voz de OpenRouter.")
    if match["voices"] and voice not in match["voices"]:
        raise TTSError(
            f"La voz '{voice}' no es válida para {model}. Voces disponibles: {', '.join(match['voices'][:12])}…"
        )

    client = _client()
    chunks = split_text(text)
    parts = [
        synthesize_chunk(client, model=model, voice=voice, text=c, speed=speed, instructions=instructions.strip(), eleven=eleven)
        for c in chunks
    ]
    return b"".join(parts), len(chunks)


def preview_speech(model: str, voice: str) -> Path:
    """Muestra corta en español de una voz. Se genera una vez y se guarda en previews/."""
    models = fetch_models()
    match = next((m for m in models if m["id"] == model), None)
    if match is None or (match["voices"] and voice not in match["voices"]):
        raise TTSError("Modelo o voz no válidos para la muestra.")
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", f"{model}__{voice}")
    path = PREVIEW_DIR / f"{safe}.mp3"
    if path.exists():
        return path
    audio = synthesize_chunk(_client(), model=model, voice=voice, text=PREVIEW_TEXT, speed=None, instructions="")
    PREVIEW_DIR.mkdir(exist_ok=True)
    path.write_bytes(audio)
    return path


def build_eleven_options(*, stability, similarity, style, speaker_boost, language) -> dict:
    """Opciones de ElevenLabs; solo incluye lo que el usuario cambió del valor por defecto."""
    settings = {}
    if stability is not None and abs(stability - 0.5) > 1e-9:
        settings["stability"] = stability
    if similarity is not None and abs(similarity - 0.75) > 1e-9:
        settings["similarity_boost"] = similarity
    if style is not None and abs(style) > 1e-9:
        settings["style"] = style
    if speaker_boost is False:
        settings["use_speaker_boost"] = False
    opts = {}
    if settings:
        opts["voice_settings"] = settings
    if language:
        opts["language_code"] = language
    return opts
