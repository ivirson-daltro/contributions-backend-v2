#!/usr/bin/env node

/**
 * Database Migration Runner
 * 
 * This script runs all pending migrations from the supabase/migrations directory.
 * It should be executed before starting the application in production or after
 * pulling new migrations from the repository.
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

try {
  // Try to use Supabase CLI if available
  execSync("supabase db push", { stdio: "inherit" });
  console.log("\n✅ Migrations completed successfully!");
} catch (error) {
  console.error("\n⚠️  Supabase CLI not found or migrations failed.");
  console.error("Please ensure:");
  console.error("  1. Supabase CLI is installed: npm install -g supabase");
  console.error("  2. You are connected to your Supabase project");
  console.error("  3. Environment variables are properly set\n");
  console.error("Run manually:");
  console.error("  supabase db push");
  process.exit(1);
}
