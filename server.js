const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".cursorignore", ".env") });
require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  connectionString: process.env.DB_CONNECTION_STRING,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS months (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      month INTEGER NOT NULL,
      year INTEGER NOT NULL,
      is_closed INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, month, year)
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
}

// --- Auth Middleware ---

const fetch = require("node-fetch");

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const resp = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "apikey": process.env.SUPABASE_ANON_KEY,
      },
    });
    if (!resp.ok) return res.status(401).json({ error: "Invalid or expired token" });
    const user = await resp.json();
    req.userId = user.id;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Auth verification failed" });
  }
}

// Serve Supabase config to frontend (anon key is public by design)
app.get("/api/config", (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
});

// All data routes require auth
app.use("/api/months", authMiddleware);
app.use("/api/shifts", authMiddleware);

// --- Pay Calculation ---

const BASE_RATE = 144.99;
const EVENING_SUPPLEMENT = 22.25;
const NIGHT_SUNDAY_SUPPLEMENT = 30.4;

function getSupplementRate(dayOfWeek, hour) {
  if (hour >= 0 && hour < 6) return NIGHT_SUNDAY_SUPPLEMENT;
  if (dayOfWeek === 0) return NIGHT_SUNDAY_SUPPLEMENT;
  if (dayOfWeek === 6 && hour >= 14) return EVENING_SUPPLEMENT;
  if (dayOfWeek >= 1 && dayOfWeek <= 5 && hour >= 18) return EVENING_SUPPLEMENT;
  return 0;
}

function calculateEarnings(dateStr, startTime, endTime, breakStart, breakEnd) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [startH, startM] = startTime.split(":").map(Number);
  const [endH, endM] = endTime.split(":").map(Number);

  const shiftStart = new Date(year, month - 1, day, startH, startM);
  let shiftEnd = new Date(year, month - 1, day, endH, endM);
  if (shiftEnd <= shiftStart) shiftEnd.setDate(shiftEnd.getDate() + 1);

  let breakStartDate = null;
  let breakEndDate = null;
  let breakMinutes = 0;

  if (breakStart && breakEnd) {
    const [bsH, bsM] = breakStart.split(":").map(Number);
    const [beH, beM] = breakEnd.split(":").map(Number);
    breakStartDate = new Date(year, month - 1, day, bsH, bsM);
    breakEndDate = new Date(year, month - 1, day, beH, beM);
    if (breakStartDate < shiftStart) breakStartDate.setDate(breakStartDate.getDate() + 1);
    if (breakEndDate <= breakStartDate) breakEndDate.setDate(breakEndDate.getDate() + 1);
    breakMinutes = (breakEndDate - breakStartDate) / 60000;
  }

  const totalShiftMinutes = (shiftEnd - shiftStart) / 60000;
  const workedMinutes = totalShiftMinutes - breakMinutes;

  if (workedMinutes <= 0) {
    return { totalHours: 0, earnings: 0, breakMinutes: 0 };
  }

  let totalEarnings = 0;
  const cursor = new Date(shiftStart);

  for (let i = 0; i < totalShiftMinutes; i++) {
    const isOnBreak =
      breakStartDate && breakEndDate &&
      cursor >= breakStartDate && cursor < breakEndDate;

    if (!isOnBreak) {
      const dow = cursor.getDay();
      const h = cursor.getHours();
      const rate = BASE_RATE + getSupplementRate(dow, h);
      totalEarnings += rate / 60;
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  const totalHours = workedMinutes / 60;
  return {
    totalHours: Math.round(totalHours * 100) / 100,
    earnings: Math.round(totalEarnings * 100) / 100,
    breakMinutes,
  };
}

function getSupplementLabel(dayOfWeek, hour) {
  if (hour >= 0 && hour < 6) return "Night supplement (00:00\u201306:00)";
  if (dayOfWeek === 0) return "Sunday supplement (06:00\u201300:00)";
  if (dayOfWeek === 6 && hour >= 14) return "Saturday supplement (14:00\u201300:00)";
  if (dayOfWeek >= 1 && dayOfWeek <= 5 && hour >= 18) return "Evening supplement (18:00\u201300:00)";
  return null;
}

const DAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

function getRateBoundaries(dayOfWeek) {
  if (dayOfWeek === 0) return [0, 6];
  if (dayOfWeek === 6) return [0, 6, 14];
  return [0, 6, 18];
}

function calculateBreakdown(dateStr, startTime, endTime, breakStart, breakEnd) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [startH, startM] = startTime.split(":").map(Number);
  const [endH, endM] = endTime.split(":").map(Number);

  const shiftStart = new Date(year, month - 1, day, startH, startM);
  let shiftEnd = new Date(year, month - 1, day, endH, endM);
  if (shiftEnd <= shiftStart) shiftEnd.setDate(shiftEnd.getDate() + 1);

  let breakStartDate = null;
  let breakEndDate = null;
  if (breakStart && breakEnd) {
    const [bsH, bsM] = breakStart.split(":").map(Number);
    const [beH, beM] = breakEnd.split(":").map(Number);
    breakStartDate = new Date(year, month - 1, day, bsH, bsM);
    breakEndDate = new Date(year, month - 1, day, beH, beM);
    if (breakStartDate < shiftStart) breakStartDate.setDate(breakStartDate.getDate() + 1);
    if (breakEndDate <= breakStartDate) breakEndDate.setDate(breakEndDate.getDate() + 1);
  }

  const boundaries = new Set();
  boundaries.add(shiftStart.getTime());
  boundaries.add(shiftEnd.getTime());
  if (breakStartDate) boundaries.add(breakStartDate.getTime());
  if (breakEndDate) boundaries.add(breakEndDate.getTime());

  const dayStart = new Date(shiftStart);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(shiftEnd);
  dayEnd.setHours(0, 0, 0, 0);
  dayEnd.setDate(dayEnd.getDate() + 1);

  for (let d = new Date(dayStart); d <= dayEnd; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    for (const h of getRateBoundaries(dow)) {
      const boundary = new Date(d);
      boundary.setHours(h, 0, 0, 0);
      if (boundary > shiftStart && boundary < shiftEnd) boundaries.add(boundary.getTime());
    }
  }

  const sortedTimes = [...boundaries].sort((a, b) => a - b);
  const segments = [];
  let totalEarnings = 0;
  let totalWorkedMinutes = 0;

  for (let i = 0; i < sortedTimes.length - 1; i++) {
    const segStart = new Date(sortedTimes[i]);
    const segEnd = new Date(sortedTimes[i + 1]);
    const minutes = (segEnd - segStart) / 60000;
    if (minutes <= 0) continue;

    const isBreak =
      breakStartDate && breakEndDate &&
      segStart >= breakStartDate && segEnd <= breakEndDate;

    const dow = segStart.getDay();
    const h = segStart.getHours();
    const supplement = getSupplementRate(dow, h);
    const rate = BASE_RATE + supplement;
    const supplementLabel = getSupplementLabel(dow, h);
    const dayName = DAY_NAMES[dow];
    const hours = minutes / 60;
    const earnings = isBreak ? 0 : Math.round(rate * hours * 100) / 100;

    if (!isBreak) {
      totalWorkedMinutes += minutes;
      totalEarnings += rate * hours;
    }

    segments.push({
      from: segStart.toTimeString().slice(0, 5),
      to: segEnd.toTimeString().slice(0, 5),
      dayName, minutes,
      hours: Math.round(hours * 100) / 100,
      isBreak, baseRate: BASE_RATE, supplement, supplementLabel, rate, earnings,
    });
  }

  return {
    segments,
    totalWorkedHours: Math.round((totalWorkedMinutes / 60) * 100) / 100,
    totalEarnings: Math.round(totalEarnings * 100) / 100,
  };
}

function getDayName(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  return DAY_NAMES[new Date(year, month - 1, day).getDay()];
}

// --- API Routes ---

app.get("/api/months", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM months WHERE user_id = $1 ORDER BY year DESC, month DESC",
      [req.userId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/months", async (req, res) => {
  const { month, year } = req.body;
  if (!month || !year) {
    return res.status(400).json({ error: "Month and year are required" });
  }
  try {
    const { rows } = await pool.query(
      "INSERT INTO months (user_id, month, year) VALUES ($1, $2, $3) RETURNING *",
      [req.userId, month, year]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === "23505") {
      return res.status(409).json({ error: "This month already exists" });
    }
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/months/:id", async (req, res) => {
  try {
    const { rows: monthRows } = await pool.query(
      "SELECT * FROM months WHERE id = $1 AND user_id = $2",
      [req.params.id, req.userId]
    );
    const month = monthRows[0];
    if (!month) return res.status(404).json({ error: "Month not found" });

    const { rows: shifts } = await pool.query(
      "SELECT * FROM shifts WHERE month_id = $1 ORDER BY date ASC, start_time ASC",
      [req.params.id]
    );
    res.json({ ...month, shifts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/months/:id/close", async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      "UPDATE months SET is_closed = 1 WHERE id = $1 AND user_id = $2",
      [req.params.id, req.userId]
    );
    if (rowCount === 0) return res.status(404).json({ error: "Month not found" });
    const { rows } = await pool.query("SELECT * FROM months WHERE id = $1", [req.params.id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/months/:id/reopen", async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      "UPDATE months SET is_closed = 0 WHERE id = $1 AND user_id = $2",
      [req.params.id, req.userId]
    );
    if (rowCount === 0) return res.status(404).json({ error: "Month not found" });
    const { rows } = await pool.query("SELECT * FROM months WHERE id = $1", [req.params.id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/months/:id/shifts", async (req, res) => {
  const { date, start_time, end_time, break_start, break_end } = req.body;
  const monthId = req.params.id;

  try {
    const { rows: monthRows } = await pool.query(
      "SELECT * FROM months WHERE id = $1 AND user_id = $2",
      [monthId, req.userId]
    );
    if (!monthRows[0]) return res.status(404).json({ error: "Month not found" });

    const dayName = getDayName(date);
    const { totalHours, earnings, breakMinutes } = calculateEarnings(
      date, start_time, end_time, break_start || null, break_end || null
    );

    const { rows } = await pool.query(
      `INSERT INTO shifts (month_id, date, start_time, end_time, break_start, break_end, break_minutes, day_name, total_hours, daily_earnings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [monthId, date, start_time, end_time, break_start || null, break_end || null, breakMinutes, dayName, totalHours, earnings]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/shifts/:id", async (req, res) => {
  const { date, start_time, end_time, break_start, break_end } = req.body;
  try {
    // Verify the shift belongs to a month owned by this user
    const { rows: check } = await pool.query(
      `SELECT s.id FROM shifts s JOIN months m ON s.month_id = m.id
       WHERE s.id = $1 AND m.user_id = $2`,
      [req.params.id, req.userId]
    );
    if (!check[0]) return res.status(404).json({ error: "Shift not found" });

    const dayName = getDayName(date);
    const { totalHours, earnings, breakMinutes } = calculateEarnings(
      date, start_time, end_time, break_start || null, break_end || null
    );

    await pool.query(
      `UPDATE shifts SET date = $1, start_time = $2, end_time = $3, break_start = $4, break_end = $5,
       break_minutes = $6, day_name = $7, total_hours = $8, daily_earnings = $9 WHERE id = $10`,
      [date, start_time, end_time, break_start || null, break_end || null, breakMinutes, dayName, totalHours, earnings, req.params.id]
    );

    const { rows } = await pool.query("SELECT * FROM shifts WHERE id = $1", [req.params.id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/shifts/:id/breakdown", async (req, res) => {
  try {
    const { rows: check } = await pool.query(
      `SELECT s.* FROM shifts s JOIN months m ON s.month_id = m.id
       WHERE s.id = $1 AND m.user_id = $2`,
      [req.params.id, req.userId]
    );
    const shift = check[0];
    if (!shift) return res.status(404).json({ error: "Shift not found" });

    const breakdown = calculateBreakdown(
      shift.date, shift.start_time, shift.end_time, shift.break_start, shift.break_end
    );
    res.json({ shift, breakdown });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/shifts/:id", async (req, res) => {
  try {
    const { rows: check } = await pool.query(
      `SELECT s.id FROM shifts s JOIN months m ON s.month_id = m.id
       WHERE s.id = $1 AND m.user_id = $2`,
      [req.params.id, req.userId]
    );
    if (!check[0]) return res.status(404).json({ error: "Shift not found" });
    await pool.query("DELETE FROM shifts WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/months/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM months WHERE id = $1 AND user_id = $2",
      [req.params.id, req.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Month not found" });
    await pool.query("DELETE FROM shifts WHERE month_id = $1", [req.params.id]);
    await pool.query("DELETE FROM months WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete user account and all their data
app.delete("/api/account", authMiddleware, async (req, res) => {
  try {
    const months = await pool.query("SELECT id FROM months WHERE user_id = $1", [req.userId]);
    const monthIds = months.rows.map(r => r.id);
    if (monthIds.length > 0) {
      await pool.query("DELETE FROM shifts WHERE month_id = ANY($1)", [monthIds]);
    }
    await pool.query("DELETE FROM months WHERE user_id = $1", [req.userId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function start() {
  const required = ["DB_CONNECTION_STRING", "SUPABASE_URL", "SUPABASE_ANON_KEY"];
  for (const key of required) {
    if (!process.env[key]) {
      console.error(`Missing ${key} in .env`);
      process.exit(1);
    }
  }
  await initDb();
  app.listen(PORT, () => {
    console.log(`MoneyTracker running at http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
