from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, Field, ConfigDict


class RestaurantCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    description: str = ""
    address: str
    cuisine: str
    image_url: str = ""


class RestaurantUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    description: str | None = None
    address: str | None = None
    cuisine: str | None = None
    image_url: str | None = None
    is_open: bool | None = None


class RestaurantPublic(BaseModel):
    """Public projection — no owner_id (avoid info disclosure / IDOR enabler)."""

    model_config = ConfigDict(populate_by_name=True)

    id: UUID = Field(alias="_id")
    name: str
    description: str
    address: str
    cuisine: str
    image_url: str
    is_open: bool
    created_at: datetime


class Restaurant(RestaurantPublic):
    """Full projection — includes owner_id. Returned only to the owner or via
    the authenticated /owner lookup endpoint."""

    owner_id: UUID


class RestaurantOwner(BaseModel):
    restaurant_id: UUID
    owner_id: UUID


class MenuItemCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    description: str = ""
    price: Decimal
    category: str = ""
    image_url: str = ""
    is_available: bool = True


class MenuItemUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    description: str | None = None
    price: Decimal | None = None
    category: str | None = None
    image_url: str | None = None
    is_available: bool | None = None


class MenuItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: UUID = Field(alias="_id")
    restaurant_id: UUID
    name: str
    description: str
    price: Decimal
    category: str
    image_url: str
    is_available: bool
