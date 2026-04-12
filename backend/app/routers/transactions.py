import os
from typing import Optional
import boto3
from boto3.dynamodb.conditions import Key
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from ..models import Transaction
from ..auth import get_current_user, verify_origin_secret

router = APIRouter(dependencies=[Depends(verify_origin_secret)])


class TransactionsResponse(BaseModel):
    transactions: list[Transaction]


@router.get("", response_model=TransactionsResponse)
async def get_transactions(
    user_id: str = Depends(get_current_user),
    from_date: Optional[str] = Query(None, alias="from"),
    to_date: Optional[str] = Query(None, alias="to"),
) -> TransactionsResponse:
    table_name = os.environ["DYNAMODB_TABLE"]
    dynamodb = boto3.resource("dynamodb")
    table = dynamodb.Table(table_name)

    key_condition = Key("userId").eq(user_id)

    if from_date and to_date:
        key_condition = key_condition & Key("date").between(from_date, to_date)
    elif from_date:
        key_condition = key_condition & Key("date").gte(from_date)
    elif to_date:
        key_condition = key_condition & Key("date").lte(to_date)

    kwargs: dict = {
        "IndexName": "userId-date-index",
        "KeyConditionExpression": key_condition,
    }

    items: list[dict] = []
    while True:
        response = table.query(**kwargs)
        items.extend(response.get("Items", []))
        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            break
        kwargs["ExclusiveStartKey"] = last_key

    transactions = [Transaction(**item) for item in items]
    return TransactionsResponse(transactions=transactions)
