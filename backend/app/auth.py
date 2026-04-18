import os
import requests
from fastapi import Header, HTTPException
from jose import jwt, jwk, JWTError

# ---------------------------------------------------------------------------
# Cached values — populated at startup via lifespan
# ---------------------------------------------------------------------------
_jwks: dict | None = None


def _get_jwks() -> dict:
    global _jwks
    if _jwks is None:
        issuer = os.environ["COGNITO_ISSUER"]
        url = f"{issuer}/.well-known/jwks.json"
        _jwks = requests.get(url, timeout=5).json()
    return _jwks


def _get_signing_key(token: str):
    """Select the JWK matching the token's kid header."""
    jwks = _get_jwks()
    try:
        headers = jwt.get_unverified_header(token)
    except JWTError as exc:
        raise ValueError(f"Invalid token header: {exc}") from exc
    kid = headers.get("kid")
    for key_data in jwks.get("keys", []):
        if key_data.get("kid") == kid:
            return jwk.construct(key_data)
    raise ValueError(f"No matching key for kid={kid!r}")


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------

async def get_current_user(x_authorization: str = Header(...)) -> str:
    """Extract and verify Cognito JWT from the X-Authorization header.

    CloudFront OAC overwrites the standard Authorization header with SigV4,
    so clients must send the JWT in X-Authorization instead.
    """
    if not x_authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = x_authorization.removeprefix("Bearer ")
    credentials_exception = HTTPException(
        status_code=401,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        issuer = os.environ["COGNITO_ISSUER"]
        client_id = os.environ["COGNITO_CLIENT_ID"]
        signing_key = _get_signing_key(token)
        payload = jwt.decode(
            token,
            signing_key,
            algorithms=["RS256"],
            audience=client_id,
            issuer=issuer,
        )
        user_id: str | None = payload.get("sub")
        if user_id is None:
            raise credentials_exception
        return user_id
    except (JWTError, ValueError):
        raise credentials_exception
