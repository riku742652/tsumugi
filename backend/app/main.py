import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import auth
from .routers import upload, transactions


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Pre-fetch JWKS and origin secret at startup to avoid blocking on first request."""
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, auth._get_jwks)
    await loop.run_in_executor(None, auth._get_origin_secret)
    yield


app = FastAPI(title="zaim-csv API", lifespan=lifespan)

cloudfront_domain = os.environ.get("CLOUDFRONT_DOMAIN", "").strip()
origins = [f"https://{cloudfront_domain}"] if cloudfront_domain else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(upload.router, prefix="/api/transactions")
app.include_router(transactions.router, prefix="/api/transactions")
