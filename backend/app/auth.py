import os
import boto3
import requests
from fastapi import Header, HTTPException, Depends
from fastapi.security import OAuth2PasswordBearer
from jose import jwt, JWTError

# ---------------------------------------------------------------------------
# Cached values — populated on first request
# ---------------------------------------------------------------------------
_origin_secret: str | None = None
_jwks: dict | None = None

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")


def _get_origin_secret() -> str:
    global _origin_secret
    if _origin_secret is None:
        secret_arn = os.environ["ORIGIN_SECRET_ARN"]
        client = boto3.client("secretsmanager")
        response = client.get_secret_value(SecretId=secret_arn)
        _origin_secret = response["SecretString"]
    return _origin_secret


def _get_jwks() -> dict:
    global _jwks
    if _jwks is None:
        issuer = os.environ["COGNITO_ISSUER"]
        url = f"{issuer}/.well-known/jwks.json"
        _jwks = requests.get(url, timeout=5).json()
    return _jwks


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------

def verify_origin_secret(x_origin_secret: str = Header(...)) -> None:
    expected = _get_origin_secret()
    if x_origin_secret != expected:
        raise HTTPException(status_code=403, detail="Forbidden")


async def get_current_user(token: str = Depends(oauth2_scheme)) -> str:
    credentials_exception = HTTPException(
        status_code=401,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        issuer = os.environ["COGNITO_ISSUER"]
        jwks = _get_jwks()
        payload = jwt.decode(
            token,
            jwks,
            algorithms=["RS256"],
            options={"verify_aud": False},
            issuer=issuer,
        )
        user_id: str | None = payload.get("sub")
        if user_id is None:
            raise credentials_exception
        return user_id
    except JWTError:
        raise credentials_exception
