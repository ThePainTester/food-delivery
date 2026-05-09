export interface MenuItemSnapshot {
  id: string;
  restaurant_id: string;
  name: string;
  price: string;
  is_available: boolean;
}

export interface RestaurantSnapshot {
  id: string;
  is_open: boolean;
  latitude: number | null;
  longitude: number | null;
}

export class RestaurantClient {
  constructor(private baseUrl: string) {}

  async getMenu(restaurantId: string): Promise<MenuItemSnapshot[]> {
    const res = await fetch(`${this.baseUrl}/restaurants/${restaurantId}/menu`);
    if (res.status === 404) throw new RestaurantNotFoundError();
    if (!res.ok) throw new Error(`restaurant service error: ${res.status}`);
    return (await res.json()) as MenuItemSnapshot[];
  }

  async getRestaurant(restaurantId: string): Promise<RestaurantSnapshot> {
    const res = await fetch(`${this.baseUrl}/restaurants/${restaurantId}`);
    if (res.status === 404) throw new RestaurantNotFoundError();
    if (!res.ok) throw new Error(`restaurant service error: ${res.status}`);
    return (await res.json()) as RestaurantSnapshot;
  }

  /**
   * Authenticated lookup. Forwards the caller's JWT — Restaurant Service's
   * /owner endpoint requires auth, and this avoids minting a service token.
   * Returns owner_id, or null if the restaurant doesn't exist.
   */
  async getOwnerId(restaurantId: string, callerJwt: string): Promise<string | null> {
    const res = await fetch(`${this.baseUrl}/restaurants/${restaurantId}/owner`, {
      headers: { authorization: `Bearer ${callerJwt}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`restaurant service error: ${res.status}`);
    const body = (await res.json()) as { owner_id: string };
    return body.owner_id;
  }
}

export class RestaurantNotFoundError extends Error {}
