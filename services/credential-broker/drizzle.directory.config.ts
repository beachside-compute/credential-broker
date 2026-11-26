import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/tenants/directory-schema.ts",
  out: "./drizzle-directory",
  dialect: "sqlite",
  driver: "durable-sqlite",
});
