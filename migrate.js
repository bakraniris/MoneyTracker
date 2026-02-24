/**
 * Migrates data from SQLite (moneytracker.db) to Supabase (PostgreSQL).
 * Run: npm run migrate
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".cursorignore", ".env") });
require("dotenv").config();

const Database = require("better-sqlite3");
const { Pool } = require("pg");

const SQLITE_PATH = path.join(__dirname, "moneytracker.db");

async function migrate() {
  if (!process.env.DB_CONNECTION_STRING) {
    console.error("Missing DB_CONNECTION_STRING in .env");
    process.exit(1);
  }

  const sqlitePath = path.join(__dirname, "moneytracker.db");
  const fs = require("fs");
  if (!fs.existsSync(sqlitePath)) {
    console.error("SQLite database not found:", sqlitePath);
    process.exit(1);
  }

  const sqlite = new Database(sqlitePath, { readonly: true });
  const pool = new Pool({
    connectionString: process.env.DB_CONNECTION_STRING,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const months = sqlite.prepare("SELECT * FROM months ORDER BY id").all();
    const shifts = sqlite.prepare("SELECT * FROM shifts ORDER BY id").all();

    console.log(`Found ${months.length} months and ${shifts.length} shifts in SQLite.`);

    if (months.length === 0 && shifts.length === 0) {
      console.log("Nothing to migrate.");
      sqlite.close();
      await pool.end();
      return;
    }

    // Ensure tables exist in Supabase
    await pool.query(`
      CREATE TABLE IF NOT EXISTS months (
        id SERIAL PRIMARY KEY,
        month INTEGER NOT NULL,
        year INTEGER NOT NULL,
        is_closed INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(month, year)
      );

      CREATE TABLE IF NOT EXISTS shifts (
        id SERIAL PRIMARY KEY,
        month_id INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        break_start TEXT,
        break_end TEXT,
        break_minutes INTEGER DEFAULT 0,
        day_name TEXT NOT NULL,
        total_hours REAL NOT NULL,
        daily_earnings REAL NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    const monthIdMap = {}; // old_id -> new_id

    for (const m of months) {
      const { rows } = await pool.query(
        `INSERT INTO months (month, year, is_closed) VALUES ($1, $2, $3) RETURNING id`,
        [m.month, m.year, m.is_closed ?? 0]
      );
      monthIdMap[m.id] = rows[0].id;
      console.log(`  Migrated month: ${m.month}/${m.year} (old id ${m.id} -> new id ${rows[0].id})`);
    }

    for (const s of shifts) {
      const newMonthId = monthIdMap[s.month_id];
      if (!newMonthId) {
        console.warn(`  Skipping shift ${s.id}: month_id ${s.month_id} not found`);
        continue;
      }

      await pool.query(
        `INSERT INTO shifts (month_id, date, start_time, end_time, break_start, break_end, break_minutes, day_name, total_hours, daily_earnings)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          newMonthId,
          s.date,
          s.start_time,
          s.end_time,
          s.break_start ?? null,
          s.break_end ?? null,
          s.break_minutes ?? 0,
          s.day_name,
          s.total_hours,
          s.daily_earnings,
        ]
      );
      console.log(`  Migrated shift: ${s.date} ${s.start_time}–${s.end_time}`);
    }

    console.log("\nMigration complete.");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    sqlite.close();
    await pool.end();
  }
}

migrate();
