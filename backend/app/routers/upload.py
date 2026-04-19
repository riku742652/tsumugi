import os
from decimal import Decimal

import boto3
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..models import Transaction
from ..auth import get_current_user

router = APIRouter()

_dynamodb = boto3.resource("dynamodb")


class UploadRequest(BaseModel):
    transactions: list[Transaction]


class UploadResponse(BaseModel):
    saved: int


@router.post("", response_model=UploadResponse)
async def upload_transactions(
    body: UploadRequest,
    user_id: str = Depends(get_current_user),
) -> UploadResponse:
    table = _dynamodb.Table(os.environ["DYNAMODB_TABLE"])

    seen: set[str] = set()
    items = []
    for tx in body.transactions:
        if tx.txId in seen:
            continue
        seen.add(tx.txId)
        items.append({
            k: (Decimal(str(v)) if isinstance(v, float) else v)
            for k, v in {**tx.model_dump(), "userId": user_id}.items()
        })

    with table.batch_writer() as batch:
        for item in items:
            batch.put_item(Item=item)

    return UploadResponse(saved=len(items))
