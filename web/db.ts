import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

/** Tiger's chain fails Node verify; sslmode=require in the URL also forces verify-full in pg 8.x. */
export function pgConfig(connectionString: string) {
  const cleaned = connectionString
    .replace(/([?&])sslmode=[^&]*/gi, "$1")
    .replace(/[?&]$/, "")
    .replace(/\?&/, "?");
  return {
    connectionString: cleaned,
    ssl: { rejectUnauthorized: false } as const,
  };
}

export function createPool(): pg.Pool {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return new Pool({
    ...pgConfig(databaseUrl),
    max: 5,
  });
}
