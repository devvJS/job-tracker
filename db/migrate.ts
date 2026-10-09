// Applies pending migrations on their own (npm run db:migrate; Railway pre-deploy later).
// Only DATABASE_URL is needed, so it runs without the app's other secrets.
import { createDb, migrate } from "../server/db.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const { db, close } = await createDb(url);
try {
  await migrate(db);
  console.log("migrations applied");
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await close();
}
