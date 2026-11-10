"""Small HTTP wrapper around Oomni's Mithi v1 Flash speech model.

Download the model card files into MITHI_MODEL_PATH and install that folder's
requirements.txt before starting this service.
"""

import os
import sys
import tempfile
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

model_path = Path(os.getenv("MITHI_MODEL_PATH", "./mithi-v1-flash")).resolve()
if not model_path.is_dir():
    raise RuntimeError("Set MITHI_MODEL_PATH to a local Oomni/mithi-v1-flash model directory.")

sys.path.insert(0, str(model_path))
from mithi_tts import Mithi  # noqa: E402

tts = Mithi(str(model_path), device=os.getenv("MITHI_DEVICE", "cpu"))
generation_lock = threading.Lock()
app = FastAPI(title="Shanaya Mithi TTS", docs_url=None, redoc_url=None)


class SynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    language: str = Field(pattern="^(en|hi|mr)$")
    voice: str = Field(default="charvi", pattern="^charvi$")


def synthesize_to_file(text: str, language: str) -> str:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as audio_file:
        output_path = audio_file.name
    try:
        with generation_lock:
            audio = tts.synthesize(text, lang=language, voice="charvi")
            tts.save(audio, output_path)
        return output_path
    except Exception:
        Path(output_path).unlink(missing_ok=True)
        raise


@app.post("/synthesize")
async def synthesize(request: SynthesisRequest):
    try:
        output_path = await run_in_threadpool(synthesize_to_file, request.text, request.language)
    except Exception as error:
        raise HTTPException(status_code=500, detail="Mithi could not synthesize this text.") from error
    return FileResponse(
        output_path,
        media_type="audio/wav",
        filename="shanaya-charvi.wav",
        background=BackgroundTask(Path(output_path).unlink, missing_ok=True),
    )
