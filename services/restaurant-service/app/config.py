from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    port: int = 8080
    mongo_url: str = Field(..., alias="MONGO_URL")
    mongo_db: str = Field("restaurants", alias="MONGO_DB")
    jwks_url: str = Field(..., alias="JWKS_URL")
    jwt_issuer: str = Field("user-service", alias="JWT_ISSUER")
    root_path: str = Field("", alias="ROOT_PATH")


def load_settings() -> Settings:
    return Settings()  # type: ignore
