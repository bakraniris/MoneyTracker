# Supabase Migration Guide

## What’s done

- SQLite has been replaced with PostgreSQL (Supabase).
- The server uses `pg` and `dotenv` instead of `better-sqlite3`.
- Tables are created automatically on startup.

## What you need to do

### 1. `.env` location

The server loads `.env` from `.cursorignore/.env` first, then falls back to the project root. Your current setup should work as-is.

### 2. Set the connection string

In `.env`:

```
DB_CONNECTION_STRING=postgresql://postgres.[project-ref]:[YOUR-PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres
```

To get it in Supabase:

1. Open your project → **Settings** → **Database**
2. Under **Connection string**, choose **URI**
3. Copy the string and replace `[YOUR-PASSWORD]` with your database password

Use either:

- **Session pooler** (port 6543) – recommended for this app
- **Direct connection** (port 5432) – if the pooler gives issues

### 3. Install dependencies and start

```bash
cd /Users/iris/Desktop/MoneyTracker
npm install
npm start
```

### 4. Optional: migrate existing data

If you have data in the old SQLite database and want it in Supabase:

1. Export from SQLite (e.g. with a small script or DB tool).
2. Insert the rows into the Supabase `months` and `shifts` tables.

If you don’t need the old data, you can ignore this step.
