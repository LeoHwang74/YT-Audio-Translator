r"""Minimal OpenAI-compatible speech-to-text server backed by faster-whisper.

Why this exists: the extension needs ``POST /v1/audio/transcriptions`` on
127.0.0.1:8000, and there is no portable, dependency-free way to get one. This
file is small on purpose — it accepts a WAV upload and returns ``{"text": ...}``.

Install with ``install.ps1`` (which creates the venv and downloads the model), or
run manually:

    python -m venv venv
    venv\Scripts\python.exe -m pip install faster-whisper fastapi uvicorn python-multipart
    venv\Scripts\python.exe asr_server.py

Environment:
    WHISPER_MODEL    model size or HF repo (default: base)
    WHISPER_THREADS  CPU threads (default: 12)
    WHISPER_PORT     listen port (default: 8000)
    WHISPER_DEVICE   cpu | cuda (default: cpu)
    WHISPER_COMPUTE  int8 | float16 (default: int8)
    HF_HOME          model cache directory
"""

import io
import os
import sys
import time
import wave

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

MODEL_NAME = os.environ.get("WHISPER_MODEL", "base")
HOST = os.environ.get("WHISPER_HOST", "127.0.0.1")
PORT = int(os.environ.get("WHISPER_PORT", "8000"))
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
# Whisper always pads to a 30s window, so latency is fixed per request rather
# than proportional to clip length. ctranslate2 defaults to 4 threads, which
# wastes most of a modern CPU: 4 -> 3.9s, 20 -> 1.8s for a 1.5s chunk.
THREADS = int(os.environ.get("WHISPER_THREADS", "12"))
TARGET_RATE = 16000

app = FastAPI(title="yt-asr", version="1.0.0")
_model = None


def decode_wav(raw):
    """Decode a PCM WAV to mono float32 @16 kHz.

    Avoids PyAV: faster-whisper routes file-like input through av, and av>=19
    dropped the ``metadata_errors`` kwarg that faster-whisper still passes.
    """
    import numpy as np

    with wave.open(io.BytesIO(raw), "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())

    if width != 2:
        raise ValueError(f"expected 16-bit PCM, got {width * 8}-bit")

    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != TARGET_RATE and audio.size:
        length = int(round(audio.size * TARGET_RATE / rate))
        audio = np.interp(
            np.linspace(0, audio.size, length, endpoint=False),
            np.arange(audio.size),
            audio,
        ).astype(np.float32)
    return audio


def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        started = time.time()
        _model = WhisperModel(
            MODEL_NAME,
            device=DEVICE,
            compute_type=COMPUTE,
            cpu_threads=THREADS,
            num_workers=1,
        )
        print(
            f"[asr] loaded {MODEL_NAME} on {DEVICE}/{COMPUTE} threads={THREADS} "
            f"in {time.time() - started:.1f}s",
            flush=True,
        )
    return _model


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "loaded": _model is not None}


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [{"id": MODEL_NAME, "object": "model"}]}


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model: str = Form(default=""),
    language: str = Form(default=""),
    response_format: str = Form(default="json"),
):
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty audio payload")

    try:
        audio = decode_wav(raw)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"cannot decode WAV: {exc}") from exc

    if audio.size == 0:
        return {"text": "", "language": "", "duration": 0.0}

    try:
        engine = get_model()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"model load failed: {exc}") from exc

    started = time.time()
    segments, info = engine.transcribe(
        audio,
        language=(language or None),
        beam_size=1,
        vad_filter=False,
        condition_on_previous_text=False,
    )
    text = " ".join(seg.text.strip() for seg in segments if seg.text.strip()).strip()
    elapsed = time.time() - started
    print(f"[asr] {len(raw)} bytes -> {text!r} ({elapsed:.2f}s, lang={info.language})", flush=True)

    if response_format == "text":
        return JSONResponse({"text": text})
    return {"text": text, "language": info.language, "duration": round(elapsed, 3)}


def main():
    import threading

    import uvicorn

    print(f"[asr] serving {MODEL_NAME} on http://{HOST}:{PORT}", flush=True)

    def warm():
        try:
            get_model()
        except Exception as exc:  # noqa: BLE001
            print(f"[asr] warmup failed: {exc}", file=sys.stderr, flush=True)

    threading.Thread(target=warm, daemon=True).start()
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
