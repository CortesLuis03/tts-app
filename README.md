# Voz — Texto a voz con OpenRouter

App web de text-to-speech: FastAPI en el backend y una sola página HTML/CSS/JS en el frontend. La voz se genera con OpenRouter (`/api/v1/audio/speech`) y la API key nunca llega al navegador.

## Requisitos

- Windows con Python 3.11 o superior
- Una API key de OpenRouter (https://openrouter.ai/keys) con saldo, o un modelo gratuito

## Instalación (Windows, PowerShell)

```powershell
cd D:\DEVELOPER\tts-app
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
```

Si PowerShell bloquea la activación, ejecuta una vez:
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## Configuración

Edita `.env` y pon tu clave:

```
OPENROUTER_API_KEY=sk-or-v1-...
```

Opcionales: `MODELO_POR_DEFECTO` (slug del modelo preferido) y `MAX_TEXT_CHARS` (límite máximo de texto, 20000 por defecto).

## Ejecutar

```powershell
uvicorn app.main:app --reload
```

Abre http://127.0.0.1:8000 en el navegador.

## Uso

1. Escribe el texto (el contador muestra el límite, que puedes bajar en el campo de debajo).
2. Elige modelo y voz. La lista de modelos viene en vivo de OpenRouter.
3. Ajusta velocidad (0.25–4.0) e instrucciones de estilo si el modelo las soporta. Con modelos ElevenLabs aparecen además Estabilidad, Similitud, Exageración de estilo, Idioma y Aumento de altavoz (solo se envían si los cambias del valor por defecto).
4. **Generar audio** → se reproduce y puedes descargar el MP3.
5. Los textos largos se dividen por oraciones en fragmentos de ~3000 caracteres y los MP3 se concatenan.
6. El historial se guarda en tu navegador con IndexedDB (audio + texto, modelo, voz y fecha). En la pestaña **Historial** puedes reproducir, descargar el MP3 cuando quieras, reusar el texto o eliminar. Es local a este navegador: si borras los datos del sitio, se pierde.

## Despliegue en VPS con Docker + Traefik

Requisitos: Docker con Compose, un Traefik ya corriendo con una red externa llamada `proxy`, y un registro DNS de `tts-app.dev-labenginnering.com` apuntando a la VPS.

1. Copia el proyecto a la VPS y crea `.env` desde `.env.example`: `OPENROUTER_API_KEY` y `TTS_BASIC_AUTH` (el dominio, la red `proxy`, el entrypoint `websecure` y el certresolver `letsencrypt` están escritos en `docker-compose.yml`; edítalos ahí si tu Traefik usa otros).
2. Genera el acceso con `htpasswd -nb usuario clave` y ponlo en `TTS_BASIC_AUTH` (duplicando cada `$` como `$$`).
3. Levanta: `docker compose up -d --build`.

**Alternativa: subir la imagen a un registro** (Docker Hub, GHCR…) y descargarla en la VPS, sin copiar el código:

```bash
docker login
docker build -t TU_USUARIO/tts-app:latest .
docker push TU_USUARIO/tts-app:latest
```

En la VPS basta con `docker-compose.yml` y `.env` (con `TTS_IMAGE=TU_USUARIO/tts-app:latest`), y luego `docker compose pull && docker compose up -d`. No incluyas tu `.env` en la imagen: la key se pasa solo en tiempo de ejecución.

La app no tiene login propio, por eso el compose protege la ruta con basic auth de Traefik: sin ella, cualquiera con la URL gastaría tus créditos de OpenRouter. Las muestras de voz se guardan en el volumen `tts_previews`; el historial de audios vive en cada navegador.

## Estructura

```
app/main.py      Rutas FastAPI y servidor del frontend
app/tts.py       Lógica de OpenRouter: modelos, división de texto, generación, errores
Dockerfile, docker-compose.yml   Despliegue con Traefik
static/          index.html, style.css, app.js
```

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/config` | Límite de caracteres y estado de la key |
| GET | `/api/models` | Modelos de voz de OpenRouter y modelo por defecto |
| POST | `/api/generate` | Genera audio `{text, model, voice, speed, instructions}` y devuelve el MP3 |

## Notas

- El modelo por defecto es `elevenlabs/eleven-multilingual-v2` (cambiable con `MODELO_POR_DEFECTO`); los modelos de ElevenLabs aparecen primero. Cada voz tiene un botón ▶ con una muestra en español, que se genera una vez y se guarda en `previews/` (cuesta unos pocos caracteres por voz).
- OpenRouter no informa qué parámetros acepta cada modelo de voz, así que `speed` solo se envía si es distinto de 1.0 e `instructions` solo si no está vacío. Si el modelo los rechaza verás el error en pantalla.
- Fuera de alcance por ahora (el código está separado para añadirlo): clonación de voz, cuentas de usuario y API pública propia.
