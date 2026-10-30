import pg from "pg";
import { createApp } from "./app.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const databaseUrl = required("DATABASE_URL");
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 5,
  ssl: databaseUrl.includes("supabase") ? { rejectUnauthorized: false } : undefined,
});

const app = createApp(pool, {
  appUrl: (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000").replace(/\/$/, ""),
  adminEmails: (process.env.ADMIN_EMAILS || "sergio.freitas@reaktor.com").split(",").map((e) => e.trim()).filter(Boolean),
  googleClientId: required("GOOGLE_CLIENT_ID"),
  googleClientSecret: required("GOOGLE_CLIENT_SECRET"),
  sessionSecret: required("SESSION_SECRET"),
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Listening on ${port}`));
