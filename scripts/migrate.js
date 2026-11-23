#!/usr/bin/env node

/**
 * Database Migration Runner
 * 
 * This script runs all pending migrations from the supabase/migrations directory.
 * It supports both local Supabase development and Supabase Cloud.
 * 
 * Usage:
 *   node scripts/migrate.js
 * 
 * Or with npm:
 *   npm run migrate
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const MIGRATIONS_DIR = path.join(__dirname, "../supabase/migrations");
const NODE_ENV = process.env.NODE_ENV || "development";
const SUPABASE_DB_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;

console.log("🗂️  Running database migrations...\n");

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

console.log(`Found ${migrations.length} migration(s):\n`);
migrations.forEach((file) => console.log(`  • ${file}`));
console.log();

// Skip migrations if in production without proper database URL
if (NODE_ENV === "production") {
  if (!SUPABASE_DB_URL) {
    console.warn("⚠️  Production mode: DATABASE_URL not set. Skipping migrations.");
    console.warn("   Make sure migrations have been run on your Supabase Cloud instance.");
    console.warn("   Run migrations manually with: supabase db push --db-url <url>\n");
    process.exit(0);
  }
  
  console.log("📡 Production mode: Attempting to migrate Supabase Cloud instance...\n");
  
  try {
    execSync(`supabase db push --db-url "${SUPABASE_DB_URL}"`, { stdio: "inherit" });
    console.log("\n✅ Migrations completed successfully!");
  } catch (error) {
    console.error("\n❌ Migration failed in production!");
    console.error("Please ensure your DATABASE_URL is correct and accessible.");
    process.exit(1);
  }
  process.exit(0);
}

// Development mode: Try local Supabase first
console.log("🏠 Development mode: Attempting local Supabase...\n");

try {
  execSync("supabase db push", { stdio: "inherit" });
  console.log("\n✅ Local migrations completed successfully!");
} catch (error) {
  if (error.message.includes("ECONNREFUSED") || error.message.includes("connect")) {
    console.error("\n⚠️  Could not connect to local Supabase database.");
    console.error("\nTo fix this, choose one of:\n");
    console.error("Option 1: Start local Supabase");
    console.error("  supabase start\n");
    console.error("Option 2: Use Supabase Cloud (set DATABASE_URL in .env)");
    console.error("  DATABASE_URL=postgresql://user:password@host:port/database\n");
    console.error("Option 3: Skip migrations during development");
    console.error("  SKIP_MIGRATIONS=true npm start\n");
    process.exit(1);
  }
  
  console.error("\n❌ Migration failed!");
  console.error(error.message);
  process.exit(1);
}

