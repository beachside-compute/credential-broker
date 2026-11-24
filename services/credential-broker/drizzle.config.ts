import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: ["./src/grants/schema.ts", "./src/integrations/schema.ts", "./src/canaries/schema.ts"],
  out: "./drizzle",
  dialect: "sqlite",
  driver: "durable-sqlite",
});
