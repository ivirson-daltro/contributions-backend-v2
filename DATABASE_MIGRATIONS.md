# Database Migrations

## Overview

This project uses Supabase for database management. All schema changes are tracked in the `supabase/migrations/` directory and must be executed before running the application.

## Running Migrations

### Automatically (Recommended)

When you run `npm start`, migrations will execute automatically before the application starts:

```bash
npm start
```

This runs:
1. `npm run migrate` - Executes all pending migrations
2. Starts the application - `node dist/main.js`

### Manually

If you prefer to run migrations separately:

```bash
npm run migrate
```

Or using Supabase CLI directly:

```bash
supabase db push
```

## Prerequisites

To run migrations, you need:

1. **Supabase CLI** installed:
   ```bash
   npm install -g supabase
   ```

2. **Environment variables** configured for your Supabase project:
   - `SUPABASE_URL` - Your Supabase project URL
   - `SUPABASE_KEY` - Your Supabase API key
   - Database connection string in `DATABASE_URL` or via `.env.local`

3. **PostgreSQL client** (pg_dump, psql) - Usually installed with Supabase CLI

## Creating New Migrations

When you need to modify the database schema:

1. Create a new SQL file in `supabase/migrations/` following the naming convention:
   ```
   YYYYMMDDHHMMSS_descriptive_name.sql
   ```

2. Write your SQL migration:
   ```sql
   -- supabase/migrations/20261123120000_add_new_column.sql
   
   alter table your_table add column new_column text;
   
   -- Add indexes, constraints, etc as needed
   ```

3. Run migrations to test:
   ```bash
   npm run migrate
   ```

4. Commit the migration file to git:
   ```bash
   git add supabase/migrations/20261123120000_add_new_column.sql
   git commit -m "Add new column to your_table"
   ```

## Troubleshooting

### "Supabase CLI not found"

Install Supabase CLI globally:
```bash
npm install -g supabase
```

Then authenticate:
```bash
supabase login
```

### "Migrations failed"

1. Check your Supabase credentials in environment variables
2. Verify the database is accessible
3. Check for SQL syntax errors in the migration file
4. Run with verbose output:
   ```bash
   supabase db push --debug
   ```

### "Migration already executed"

If you see warnings about migrations already being applied, that's normal. Each migration is tracked and won't be re-applied.

## Recent Migrations

### Payment Method Kind Fix (2026-11-23)

Two migrations were added to fix the issue where "Dinheiro" (cash) payments were showing as "Outros" (others):

- `20261123102759_ensure_payment_methods_kind.sql` - Ensures all payment_methods have valid kind values
- `20261123102800_populate_kind_snapshot.sql` - Populates kind_snapshot for existing contributions

These must be run before the application will show correct payment method types in reports.
