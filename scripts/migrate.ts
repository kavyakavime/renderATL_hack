import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { pgConfig } from "../web/db.js";

const { Client } = pg;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const sqlPath = path.join(__dirname, "..", "migrations", "001_init.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");

  const client = new Client(pgConfig(databaseUrl));
  await client.connect();
  try {
    await client.query(sql);
    console.log("Migration 001_init.sql applied.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
