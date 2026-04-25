from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase


class Mongo:
    def __init__(self, url: str, db_name: str) -> None:
        self._client = AsyncIOMotorClient(url, uuidRepresentation="standard")
        self.db: AsyncIOMotorDatabase = self._client[db_name]

    async def ensure_indexes(self) -> None:
        await self.db.restaurants.create_index("owner_id")
        await self.db.restaurants.create_index("cuisine")
        await self.db.menu_items.create_index("restaurant_id")

    def close(self) -> None:
        self._client.close()
