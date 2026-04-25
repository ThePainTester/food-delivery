from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Query, Request, status

from ..auth import Principal, require_auth, require_role
from ..errors import forbidden, not_found
from ..schemas import Restaurant, RestaurantCreate, RestaurantUpdate

router = APIRouter(prefix="/restaurants", tags=["restaurants"])


def _db(request: Request):
    return request.app.state.mongo.db


@router.get("", response_model=list[Restaurant])
async def list_restaurants(
    request: Request,
    cuisine: str | None = Query(None),
    is_open: bool | None = Query(None),
    search: str | None = Query(None),
):
    q: dict = {}
    if cuisine:
        q["cuisine"] = cuisine
    if is_open is not None:
        q["is_open"] = is_open
    if search:
        q["name"] = {"$regex": search, "$options": "i"}
    cursor = _db(request).restaurants.find(q)
    return [Restaurant.model_validate(doc) async for doc in cursor]


@router.get("/{restaurant_id}", response_model=Restaurant)
async def get_restaurant(restaurant_id: UUID, request: Request):
    doc = await _db(request).restaurants.find_one({"_id": restaurant_id})
    if not doc:
        raise not_found("restaurant not found")
    return Restaurant.model_validate(doc)


@router.post("", response_model=Restaurant, status_code=status.HTTP_201_CREATED)
async def create_restaurant(
    body: RestaurantCreate,
    request: Request,
    principal: Principal = Depends(require_role("restaurant")),
):
    doc = {
        "_id": uuid4(),
        "owner_id": UUID(principal.user_id),
        "name": body.name,
        "description": body.description,
        "address": body.address,
        "cuisine": body.cuisine,
        "image_url": body.image_url,
        "is_open": False,
        "created_at": datetime.now(timezone.utc),
    }
    await _db(request).restaurants.insert_one(doc)
    return Restaurant.model_validate(doc)


@router.patch("/{restaurant_id}", response_model=Restaurant)
async def update_restaurant(
    restaurant_id: UUID,
    body: RestaurantUpdate,
    request: Request,
    principal: Principal = Depends(require_auth),
):
    db = _db(request)
    existing = await db.restaurants.find_one({"_id": restaurant_id})
    if not existing:
        raise not_found("restaurant not found")
    if str(existing["owner_id"]) != principal.user_id or principal.role != "restaurant":
        raise forbidden("not owner")

    updates = body.model_dump(exclude_unset=True)
    if updates:
        await db.restaurants.update_one({"_id": restaurant_id}, {"$set": updates})
        existing.update(updates)
    return Restaurant.model_validate(existing)
