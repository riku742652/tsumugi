import os
import boto3
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..models import Transaction
from ..auth import get_current_user, verify_origin_secret

router = APIRouter(dependencies=[Depends(verify_origin_secret)])


class UploadRequest(BaseModel):
    transactions: list[Transaction]


class UploadResponse(BaseModel):
    saved: int


@router.post("", response_model=UploadResponse)
async def upload_transactions(
    body: UploadRequest,
    user_id: str = Depends(get_current_user),
) -> UploadResponse:
    table_name = os.environ["DYNAMODB_TABLE"]
    dynamodb = boto3.resource("dynamodb")
    table = dynamodb.Table(table_name)

    items = [
        {**tx.model_dump(), "userId": user_id}
        for tx in body.transactions
    ]

    # batch_write_item processes up to 25 items at a time
    with table.batch_writer() as batch:
        for item in items:
            batch.put_item(Item=item)

    return UploadResponse(saved=len(items))
