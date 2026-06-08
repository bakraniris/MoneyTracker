const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".cursorignore", ".env") });
require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: "30mb" })); // raised for base64 avatar/cover/post attachments
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

    CREATE TABLE IF NOT EXISTS profiles (
      user_id TEXT PRIMARY KEY,
      full_name TEXT,
      headline TEXT,
      bio TEXT,
      date_of_birth TEXT,
      location TEXT,
      occupation TEXT,
      education TEXT,
      website TEXT,
      avatar_url TEXT,
      cover_theme TEXT,
      cover_image TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS cover_theme TEXT;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS cover_image TEXT;

    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      content TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS post_attachments (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,          -- 'image' | 'file'
      name TEXT,
      mime TEXT,
      data TEXT NOT NULL,          -- data URL
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE posts ADD COLUMN IF NOT EXISTS wall_owner_id TEXT; -- profile this was posted on
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS mentions JSONB;      -- [{user_id, full_name}]

    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS likes (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      target_type TEXT NOT NULL,   -- 'post' | 'comment'
      target_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, target_type, target_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      read_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (sender_id, recipient_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_recipient_unread ON messages (recipient_id, read_at);
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments JSONB;
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
app.use("/api/profile", authMiddleware);
app.use("/api/posts", authMiddleware);
app.use("/api/comments", authMiddleware);
app.use("/api/likes", authMiddleware);
app.use("/api/users", authMiddleware);
app.use("/api/conversations", authMiddleware);
app.use("/api/messages", authMiddleware);

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

// --- Profile ---

const PROFILE_FIELDS = [
  "full_name", "headline", "bio", "date_of_birth",
  "location", "occupation", "education", "website", "avatar_url",
  "cover_theme", "cover_image",
];

app.get("/api/profile", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM profiles WHERE user_id = $1",
      [req.userId]
    );
    // Return an empty profile shell if none exists yet
    if (!rows[0]) {
      const empty = { user_id: req.userId };
      PROFILE_FIELDS.forEach((f) => (empty[f] = null));
      return res.json(empty);
    }
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/profile", async (req, res) => {
  // Only accept known fields; coerce empty strings to null
  const values = PROFILE_FIELDS.map((f) => {
    const v = req.body[f];
    return v === undefined || v === "" ? null : v;
  });

  try {
    const cols = PROFILE_FIELDS.join(", ");
    const insertPlaceholders = PROFILE_FIELDS.map((_, i) => `$${i + 2}`).join(", ");
    const updateSet = PROFILE_FIELDS.map((f) => `${f} = EXCLUDED.${f}`).join(", ");

    const { rows } = await pool.query(
      `INSERT INTO profiles (user_id, ${cols})
       VALUES ($1, ${insertPlaceholders})
       ON CONFLICT (user_id) DO UPDATE SET ${updateSet}, updated_at = NOW()
       RETURNING *`,
      [req.userId, ...values]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// View any user's profile + their timeline (own posts + posts on their wall).
// Read-only: editing is only ever possible via PUT /api/profile (own account).
app.get("/api/profile/:userId", async (req, res) => {
  const targetId = req.params.userId;
  try {
    const { rows } = await pool.query("SELECT * FROM profiles WHERE user_id = $1", [targetId]);
    let profile = rows[0];
    if (!profile) {
      profile = { user_id: targetId };
      PROFILE_FIELDS.forEach((f) => (profile[f] = null));
    }
    const posts = await loadEnrichedPosts(
      req.userId,
      "(p.wall_owner_id = $2 OR (p.user_id = $2 AND p.wall_owner_id IS NULL))",
      [targetId]
    );
    res.json({ profile, posts, isSelf: targetId === req.userId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Social feed: posts, comments, likes ---

const MAX_ATTACHMENTS = 10;

// Load enriched posts (author, wall owner, attachments, comments, likes) for a
// given WHERE clause. $1 is always the viewer id; extra filter params start at $2.
async function loadEnrichedPosts(viewerId, whereSql, extraParams = []) {
  const { rows: posts } = await pool.query(
    `SELECT p.id, p.user_id, p.wall_owner_id, p.content, p.mentions, p.created_at,
            pr.full_name, pr.avatar_url, pr.cover_theme,
            wo.full_name AS wall_owner_name,
            (SELECT COUNT(*) FROM likes l WHERE l.target_type='post' AND l.target_id=p.id)::int AS like_count,
            EXISTS(SELECT 1 FROM likes l WHERE l.target_type='post' AND l.target_id=p.id AND l.user_id=$1) AS liked
     FROM posts p
     LEFT JOIN profiles pr ON pr.user_id = p.user_id
     LEFT JOIN profiles wo ON wo.user_id = p.wall_owner_id
     WHERE ${whereSql}
     ORDER BY p.created_at DESC
     LIMIT 100`,
    [viewerId, ...extraParams]
  );

  if (posts.length === 0) return [];
  const postIds = posts.map((p) => p.id);

  const { rows: attachments } = await pool.query(
    "SELECT id, post_id, kind, name, mime, data FROM post_attachments WHERE post_id = ANY($1) ORDER BY id ASC",
    [postIds]
  );

  const { rows: comments } = await pool.query(
    `SELECT c.id, c.post_id, c.user_id, c.content, c.created_at,
            pr.full_name, pr.avatar_url, pr.cover_theme,
            (SELECT COUNT(*) FROM likes l WHERE l.target_type='comment' AND l.target_id=c.id)::int AS like_count,
            EXISTS(SELECT 1 FROM likes l WHERE l.target_type='comment' AND l.target_id=c.id AND l.user_id=$2) AS liked
     FROM comments c LEFT JOIN profiles pr ON pr.user_id = c.user_id
     WHERE c.post_id = ANY($1)
     ORDER BY c.created_at ASC`,
    [postIds, viewerId]
  );

  const map = {};
  posts.forEach((p) => (map[p.id] = { ...p, attachments: [], comments: [] }));
  attachments.forEach((a) => map[a.post_id] && map[a.post_id].attachments.push(a));
  comments.forEach((c) => map[c.post_id] && map[c.post_id].comments.push(c));
  return posts.map((p) => map[p.id]);
}

// Home feed: general posts only (not wall posts)
app.get("/api/posts", async (req, res) => {
  try {
    const posts = await loadEnrichedPosts(req.userId, "p.wall_owner_id IS NULL");
    res.json(posts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a post (optional text + attachments; optional wall_owner_id + mentions)
app.post("/api/posts", async (req, res) => {
  const { content, attachments, wall_owner_id, mentions } = req.body;
  const list = Array.isArray(attachments) ? attachments.slice(0, MAX_ATTACHMENTS) : [];
  const mentionList = Array.isArray(mentions)
    ? mentions
        .filter((m) => m && m.user_id)
        .slice(0, 20)
        .map((m) => ({ user_id: String(m.user_id), full_name: m.full_name || null }))
    : [];
  const wallOwner = wall_owner_id ? String(wall_owner_id) : null;

  if ((!content || !content.trim()) && list.length === 0) {
    return res.status(400).json({ error: "Post needs text or an attachment" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "INSERT INTO posts (user_id, content, wall_owner_id, mentions) VALUES ($1, $2, $3, $4::jsonb) RETURNING id",
      [req.userId, content ? content.trim() : null, wallOwner, mentionList.length ? JSON.stringify(mentionList) : null]
    );
    const postId = rows[0].id;
    for (const a of list) {
      if (!a || !a.data) continue;
      await client.query(
        "INSERT INTO post_attachments (post_id, kind, name, mime, data) VALUES ($1, $2, $3, $4, $5)",
        [postId, a.kind === "image" ? "image" : "file", a.name || null, a.mime || null, a.data]
      );
    }
    await client.query("COMMIT");
    res.json({ id: postId });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Delete own post (cascades attachments + comments; clean up likes)
app.delete("/api/posts/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id FROM posts WHERE id = $1 AND user_id = $2",
      [req.params.id, req.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Post not found" });

    const { rows: commentRows } = await pool.query("SELECT id FROM comments WHERE post_id = $1", [req.params.id]);
    const commentIds = commentRows.map((c) => c.id);
    if (commentIds.length > 0) {
      await pool.query("DELETE FROM likes WHERE target_type='comment' AND target_id = ANY($1)", [commentIds]);
    }
    await pool.query("DELETE FROM likes WHERE target_type='post' AND target_id = $1", [req.params.id]);
    await pool.query("DELETE FROM posts WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add a comment to a post
app.post("/api/posts/:id/comments", async (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: "Comment cannot be empty" });
  try {
    const { rows: postRows } = await pool.query("SELECT id FROM posts WHERE id = $1", [req.params.id]);
    if (!postRows[0]) return res.status(404).json({ error: "Post not found" });
    const { rows } = await pool.query(
      "INSERT INTO comments (post_id, user_id, content) VALUES ($1, $2, $3) RETURNING id",
      [req.params.id, req.userId, content.trim()]
    );
    res.json({ id: rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete own comment
app.delete("/api/comments/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id FROM comments WHERE id = $1 AND user_id = $2",
      [req.params.id, req.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Comment not found" });
    await pool.query("DELETE FROM likes WHERE target_type='comment' AND target_id = $1", [req.params.id]);
    await pool.query("DELETE FROM comments WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Toggle a like on a post or comment
app.post("/api/likes", async (req, res) => {
  const { target_type, target_id } = req.body;
  if (!["post", "comment"].includes(target_type) || !target_id) {
    return res.status(400).json({ error: "Invalid like target" });
  }
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM likes WHERE user_id = $1 AND target_type = $2 AND target_id = $3",
      [req.userId, target_type, target_id]
    );
    let liked;
    if (rowCount > 0) {
      liked = false;
    } else {
      await pool.query(
        "INSERT INTO likes (user_id, target_type, target_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [req.userId, target_type, target_id]
      );
      liked = true;
    }
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS count FROM likes WHERE target_type = $1 AND target_id = $2",
      [target_type, target_id]
    );
    res.json({ liked, count: rows[0].count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Direct messages / chat ---

// All other users (to start a chat with)
app.get("/api/users", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT user_id, full_name, avatar_url, cover_theme
       FROM profiles WHERE user_id <> $1
       ORDER BY full_name NULLS LAST, user_id`,
      [req.userId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Conversations: each chat partner with last message + unread count
app.get("/api/conversations", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `WITH partners AS (
         SELECT CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS partner_id,
                MAX(created_at) AS last_at
         FROM messages
         WHERE sender_id = $1 OR recipient_id = $1
         GROUP BY partner_id
       )
       SELECT p.partner_id, p.last_at,
              pr.full_name, pr.avatar_url, pr.cover_theme,
              (SELECT m.content FROM messages m
                 WHERE (m.sender_id = $1 AND m.recipient_id = p.partner_id)
                    OR (m.sender_id = p.partner_id AND m.recipient_id = $1)
                 ORDER BY m.created_at DESC LIMIT 1) AS last_message,
              (SELECT m.sender_id FROM messages m
                 WHERE (m.sender_id = $1 AND m.recipient_id = p.partner_id)
                    OR (m.sender_id = p.partner_id AND m.recipient_id = $1)
                 ORDER BY m.created_at DESC LIMIT 1) AS last_sender,
              (SELECT COUNT(*) FROM messages m
                 WHERE m.sender_id = p.partner_id AND m.recipient_id = $1 AND m.read_at IS NULL)::int AS unread
       FROM partners p
       LEFT JOIN profiles pr ON pr.user_id = p.partner_id
       ORDER BY p.last_at DESC`,
      [req.userId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Total unread (for the nav badge). Defined before /:userId so it isn't shadowed.
app.get("/api/messages/unread-total", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS count FROM messages WHERE recipient_id = $1 AND read_at IS NULL",
      [req.userId]
    );
    res.json({ count: rows[0].count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Thread with one user (and mark their messages to me as read)
app.get("/api/messages/:userId", async (req, res) => {
  const other = req.params.userId;
  try {
    const { rows } = await pool.query(
      `SELECT id, sender_id, recipient_id, content, attachments, created_at
       FROM messages
       WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
       ORDER BY created_at ASC LIMIT 500`,
      [req.userId, other]
    );
    await pool.query(
      "UPDATE messages SET read_at = NOW() WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL",
      [req.userId, other]
    );
    const { rows: peer } = await pool.query(
      "SELECT user_id, full_name, avatar_url, cover_theme FROM profiles WHERE user_id = $1",
      [other]
    );
    res.json({ messages: rows, peer: peer[0] || { user_id: other, full_name: null, avatar_url: null } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send a message (text and/or attachments)
app.post("/api/messages", async (req, res) => {
  const { recipient_id, content, attachments } = req.body;
  const list = Array.isArray(attachments) ? attachments.slice(0, MAX_ATTACHMENTS) : [];
  if (!recipient_id) {
    return res.status(400).json({ error: "Recipient is required" });
  }
  if ((!content || !content.trim()) && list.length === 0) {
    return res.status(400).json({ error: "Message needs text or an attachment" });
  }
  if (recipient_id === req.userId) {
    return res.status(400).json({ error: "You can't message yourself" });
  }
  try {
    const cleaned = list
      .filter((a) => a && a.data)
      .map((a) => ({ kind: a.kind === "image" ? "image" : "file", name: a.name || null, mime: a.mime || null, data: a.data }));
    const { rows } = await pool.query(
      `INSERT INTO messages (sender_id, recipient_id, content, attachments)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id, sender_id, recipient_id, content, attachments, created_at`,
      [req.userId, recipient_id, content ? content.trim() : null, cleaned.length ? JSON.stringify(cleaned) : null]
    );
    res.json(rows[0]);
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
    await pool.query("DELETE FROM profiles WHERE user_id = $1", [req.userId]);

    // Feed cleanup: own likes, own comments, and own posts (cascades attachments/comments)
    const ownPosts = await pool.query("SELECT id FROM posts WHERE user_id = $1", [req.userId]);
    const ownPostIds = ownPosts.rows.map((r) => r.id);
    await pool.query("DELETE FROM likes WHERE user_id = $1", [req.userId]);
    await pool.query("DELETE FROM comments WHERE user_id = $1", [req.userId]);
    if (ownPostIds.length > 0) {
      await pool.query("DELETE FROM likes WHERE target_type='post' AND target_id = ANY($1)", [ownPostIds]);
    }
    await pool.query("DELETE FROM posts WHERE user_id = $1", [req.userId]);
    await pool.query("DELETE FROM messages WHERE sender_id = $1 OR recipient_id = $1", [req.userId]);
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
