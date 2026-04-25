from dataclasses import dataclass
from typing import Literal

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

Role = Literal["customer", "restaurant", "delivery"]

_bearer = HTTPBearer(auto_error=False)


@dataclass
class Principal:
    user_id: str
    role: Role


def _unauthorized(msg: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"error": "unauthorized", "message": msg},
    )


def require_auth(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> Principal:
    if creds is None or creds.scheme.lower() != "bearer":
        raise _unauthorized("missing bearer token")
    public_key: bytes = request.app.state.jwt_public_key
    issuer: str = request.app.state.jwt_issuer
    try:
        claims = jwt.decode(
            creds.credentials,
            public_key,
            algorithms=["RS256"],
            issuer=issuer,
            options={"require": ["exp", "iat", "user_id", "role"]},
        )
    except jwt.PyJWTError:
        raise _unauthorized("invalid token")

    role = claims.get("role")
    if role not in ("customer", "restaurant", "delivery"):
        raise _unauthorized("invalid role")
    return Principal(user_id=claims["user_id"], role=role)


def require_role(*roles: Role):
    def checker(p: Principal = Depends(require_auth)) -> Principal:
        if p.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"error": "forbidden", "message": "insufficient role"},
            )
        return p

    return checker
