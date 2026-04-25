from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    port: int = 8080
    mongo_url: str = Field(..., alias="MONGO_URL")
    mongo_db: str = Field("restaurants", alias="MONGO_DB")
    jwt_public_key_path: str = Field(..., alias="JWT_PUBLIC_KEY_PATH")
    jwt_issuer: str = Field("user-service", alias="JWT_ISSUER")


def load_settings() -> Settings:
    return Settings()  # type: ignore


def read_public_key(path: str) -> bytes:
    return Path(path).read_bytes()
