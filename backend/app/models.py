from typing import Literal
from pydantic import BaseModel, ConfigDict

TransactionType = Literal["payment", "income", "transfer", "balance"]


class Transaction(BaseModel):
    model_config = ConfigDict(extra="ignore")

    txId: str  # {date}#{uuid}
    date: str
    type: TransactionType
    category: str
    subcategory: str
    shop: str
    income: float
    expense: float
    transfer: float
    aggregation: str
