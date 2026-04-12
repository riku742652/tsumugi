from typing import Literal
from pydantic import BaseModel

TransactionType = Literal["payment", "income", "transfer", "balance"]


class Transaction(BaseModel):
    userId: str
    txId: str  # {date}#{uuid}
    date: str
    type: TransactionType
    category: str
    subcategory: str
    shop: str
    income: int
    expense: int
    transfer: int
    aggregation: str
