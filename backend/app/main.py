import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers import upload, transactions

app = FastAPI(title="zaim-csv API")

cloudfront_domain = os.environ.get("CLOUDFRONT_DOMAIN", "*")
origins = [f"https://{cloudfront_domain}"] if cloudfront_domain != "*" else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(upload.router, prefix="/api/transactions")
app.include_router(transactions.router, prefix="/api/transactions")
