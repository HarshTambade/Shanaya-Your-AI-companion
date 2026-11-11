"""Development launcher that reads the root .env before starting FastAPI."""

from __future__ import annotations

import os

import uvicorn
from dotenv import load_dotenv

load_dotenv()

if __name__ == "__main__":
    uvicorn.run(
        "backend.main:app",
        host=os.getenv("SHANAYA_HOST", "127.0.0.1"),
        port=int(os.getenv("SHANAYA_PORT", "8000")),
        reload=True,
    )
