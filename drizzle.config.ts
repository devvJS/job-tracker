import { defineConfig } from "drizzle-kit";

// drizzle-kit only generates SQL from db/schema.ts; it never connects.
// Migrations are applied by migrate(db) in server/db.ts (npm run db:migrate).
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./db/migrations",
});
