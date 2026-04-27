import type { Config } from "drizzle-kit";

const config: Config = {
    schema: "./lib/db/schema.ts",
    out: "./drizzle",
    dialect: "postgresql",
    dbCredentials: {
        url: process.env.DATABASE_URL ?? "",
    },
    strict: true,
};

export default config;
