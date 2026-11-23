#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const MIGRATIONS_DIR = path.join(__dirname, "../supabase/migrations");
const NODE_ENV = process.env.NODE_ENV || "development";
const DATABASE_URL = process.env.DATABASE_URL;
const SKIP_MIGRATIONS = process.env.SKIP_MIGRATIONS === "true";

console.log("🗂️  Running database migrations...\n");

if (SKIP_MIGRATIONS) {
  console.log("⏭️  Migrations skipped (SKIP_MIGRATIONS=true)");
  process.exit(0);
}

if (!fs.existsSync(MIGRATIONS_DIR)) {
  console.error(`❌ Migrations directory not found: ${MIGRATIONS_DIR}`);
  process.exit(1);
}

const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort();

if (migrations.length === 0) {
  console.log("✅ No migrations to run.");
  process.exit(0);
}

console.log(`Found ${migrations.length} migration(s):`);
migrations.forEach((file) => console.log(`  • ${file}`));
console.log();

let command = "supabase db push";

if (DATABASE_URL) {
  console.log("📡 Using Supabase Cloud (DATABASE_URL is set)\n");
  command += ` --db-url "${DATABASE_URL}"`;
} else if (NODE_ENV === "production") {
  console.warn("⚠️  Production mode: DATABASE_URL not set. Skipping migrations.");
  console.warn("   Ensure migrations have been run on your database.\n");
  process.exit(0);
} else {
  console.log("🏠 Development mode: Attempting local Supabase (or use DATABASE_URL)\n");
}

try {
  execSync(command, { stdio: "inherit" });
  console.log("\n✅ Migrations completed successfully!");
  process.exit(0);
} catch (error) {
  if (error.message.includes("ECONNREFUSED") || error.message.includes("connect")) {
    if (DATABASE_URL) {
      console.error("\n❌ Could not connect to Supabase Cloud database.");
      console.error("Please check your DATABASE_URL is correct and accessible.\n");
    } else {
      console.error("\n❌ Could not connect to local Supabase database.");
      console.error("\nOptions:");
      console.error("  1. Start local Supabase: supabase start");
      console.error("  2. Use Supabase Cloud: set DATABASE_URL in .env");
      console.error("  3. Skip migrations: SKIP_MIGRATIONS=true npm start\n");
    }
    process.exit(1);
  }
  
  console.error("\n❌ Migration failed!");
  console.error(error.message);
  process.exit(1);
}

