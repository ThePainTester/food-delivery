import { Pool, types } from "pg";

// Parse NUMERIC as string to preserve precision; we convert to cents (int) at the boundary.
types.setTypeParser(1700, (v) => v);

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}
