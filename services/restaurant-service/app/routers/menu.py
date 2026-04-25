from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Request, Response, status

from ..auth import Principal, require_auth
from ..errors import forbidden, not_found
from ..schemas import MenuItem, MenuItemCreate, MenuItemUpdate

router = APIRouter(prefix="/restaurants/{restaurant_id}/menu", tags=["menu"])


def _db(request: Request):
    return request.app.state.mongo.db


async def _assert_owner(request: Request, restaurant_id: UUID, principal: Principal) -> None:
    r = await _db(request).restaurants.find_one({"_id": restaurant_id}, {"owner_id": 1})
    if not r:
        raise not_found("restaurant not found")
    if str(r["owner_id"]) != principal.user_id or principal.role != "restaurant":
        raise forbidden("not owner")


@router.get("", response_model=list[MenuItem])
async def list_menu(restaurant_id: UUID, request: Request):
    if not await _db(request).restaurants.find_one({"_id": restaurant_id}, {"_id": 1}):
        raise not_found("restaurant not found")
    cursor = _db(request).menu_items.find({"restaurant_id": restaurant_id})
    return [MenuItem.model_validate(doc) async for doc in cursor]


@router.post("", response_model=MenuItem, status_code=status.HTTP_201_CREATED)
async def create_item(
    restaurant_id: UUID,
    body: MenuItemCreate,
    request: Request,
    principal: Principal = Depends(require_auth),
):
    await _assert_owner(request, restaurant_id, principal)
    doc = {
        "_id": uuid4(),
        "restaurant_id": restaurant_id,
        "name": body.name,
        "description": body.description,
        "price": str(body.price),
        "category": body.category,
        "image_url": body.image_url,
        "is_available": body.is_available,
    }
    await _db(request).menu_items.insert_one(doc)
    return MenuItem.model_validate(doc)


@router.patch("/{item_id}", response_model=MenuItem)
async def update_item(
    restaurant_id: UUID,
    item_id: UUID,
    body: MenuItemUpdate,
    request: Request,
    principal: Principal = Depends(require_auth),
):
    await _assert_owner(request, restaurant_id, principal)
    db = _db(request)
    existing = await db.menu_items.find_one({"_id": item_id, "restaurant_id": restaurant_id})
    if not existing:
        raise not_found("menu item not found")

    updates = body.model_dump(exclude_unset=True)
    if "price" in updates and updates["price"] is not None:
        updates["price"] = str(updates["price"])
    if updates:
        await db.menu_items.update_one({"_id": item_id}, {"$set": updates})
        existing.update(updates)
    return MenuItem.model_validate(existing)


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_item(
    restaurant_id: UUID,
    item_id: UUID,
    request: Request,
    principal: Principal = Depends(require_auth),
):
    await _assert_owner(request, restaurant_id, principal)
    result = await _db(request).menu_items.delete_one(
        {"_id": item_id, "restaurant_id": restaurant_id}
    )
    if result.deleted_count == 0:
        raise not_found("menu item not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
