from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, Field, ConfigDict


class RestaurantCreate(BaseModel):
    name: str
    description: str = ""
    address: str
    cuisine: str
    image_url: str = ""


class RestaurantUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    address: str | None = None
    cuisine: str | None = None
    image_url: str | None = None
    is_open: bool | None = None


class Restaurant(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: UUID = Field(alias="_id")
    owner_id: UUID
    name: str
    description: str
    address: str
    cuisine: str
    image_url: str
    is_open: bool
    created_at: datetime


class MenuItemCreate(BaseModel):
    name: str
    description: str = ""
    price: Decimal
    category: str = ""
    image_url: str = ""
    is_available: bool = True


class MenuItemUpdate(BaseModel):
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
