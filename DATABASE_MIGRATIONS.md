# Database Migrations

## Overview

This project uses Supabase for database management. All schema changes are tracked in the `supabase/migrations/` directory and must be executed before running the application in production.

## Running Migrations

### Automatically (Recommended)

When you run `npm start`, migrations will execute automatically:

```bash
npm start
```

This runs:
1. `npm run build` - Compiles the application
2. `npm run migrate` - Executes all pending migrations
3. Starts the application - `node dist/main.js`

### Manually

If you prefer to run migrations separately:

```bash
npm run migrate
```

## Environment Setup

### For Local Development (Recommended)

Start a local Supabase instance:

```bash
# Install Supabase CLI globally
npm install -g supabase

# Start local Supabase (creates a PostgreSQL instance on localhost:54322)
supabase start

# Then run your app - migrations will execute automatically
npm start
```

This is the easiest way to develop locally without needing cloud credentials.

### For Supabase Cloud

If you're using Supabase Cloud or a remote PostgreSQL database:

1. Set up your `.env` file with the database URL:
   ```bash
   cp .env.example .env
   ```

2. Update `DATABASE_URL` in `.env`:
   ```env
   DATABASE_URL=postgresql://user:password@host:port/database
   ```

3. Run your app:
   ```bash
   npm start
   ```

The migration runner will detect this and use your cloud database.

### Skip Migrations During Development

If you want to skip migrations during development (e.g., using an existing database):

```bash
# Windows
set SKIP_MIGRATIONS=true && npm start

# macOS/Linux
SKIP_MIGRATIONS=true npm start
```

## How It Works

The migration runner (`scripts/migrate.js`) automatically handles different environments:

| Environment | Behavior |
|------------|----------|
| **Development + Local Supabase** | Connects to `localhost:54322` and runs migrations |
| **Development + Cloud Database** | Uses `DATABASE_URL` from `.env` and runs migrations |
| **Development + No Database** | Displays helpful error message with options |
| **Production + DATABASE_URL set** | Uses `DATABASE_URL` and runs migrations |
| **Production + No DATABASE_URL** | Shows warning and skips migrations (assumes already applied) |

## Prerequisites

To run migrations, you need:

1. **Supabase CLI** installed:
   ```bash
   npm install -g supabase
   ```

2. **For local development**: PostgreSQL client tools (included with Supabase CLI)

3. **For cloud**: A valid `DATABASE_URL` environment variable pointing to your database

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

### "dial error (connect ECONNREFUSED 127.0.0.1:54322)"

This means local Supabase is not running. Choose one of these options:

**Option 1: Start local Supabase** (Recommended for development)
```bash
supabase start
npm start
```

**Option 2: Use Supabase Cloud**
```bash
# Update .env with your cloud database URL
DATABASE_URL=postgresql://user:password@host:port/database
npm start
```

**Option 3: Skip migrations temporarily**
```bash
SKIP_MIGRATIONS=true npm start
```

### "Supabase CLI not found"

Install Supabase CLI globally:
```bash
npm install -g supabase
```

Then authenticate (for cloud operations):
```bash
supabase login
```

### "Migration failed in production"

1. Verify `DATABASE_URL` is set correctly
2. Check database is accessible from your server
3. Run migrations manually with verbose output:
   ```bash
   supabase db push --debug --db-url "your-url"
   ```

### "Migration already executed"

This is normal. Each migration is tracked and won't be re-applied. You can safely run migrations multiple times.

## Recent Migrations

### Payment Method Kind Fix (2026-11-23)

Two migrations were added to fix the issue where "Dinheiro" (cash) payments were showing as "Outros" (others):

- `20261123102759_ensure_payment_methods_kind.sql` - Ensures all payment_methods have valid kind values
- `20261123102800_populate_kind_snapshot.sql` - Populates kind_snapshot for existing contributions

**These must be run** before the application will show correct payment method types in reports.

## Production Deployment

For production deployment:

1. Ensure `DATABASE_URL` is set to your production database
2. Build the application: `npm run build`
3. Run migrations: `npm run migrate`
4. Start the application: `node dist/main.js`

Or use the standard start command which does all of this:
```bash
npm start
```

The migration runner will automatically use your production database credentials.

