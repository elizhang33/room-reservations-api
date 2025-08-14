import express from "express";
import cors from "cors";
import pkg from "pg";
import { v4 as uuidv4 } from 'uuid';

const { Pool } = pkg;

const app = express();
app.use(express.json());
app.use(cors({ origin: "*"}));

const INVENTORY = {
  Library: [
    { room: 'L201', capacity: 5 },
    { room: 'L202', capacity: 8 },
    { room: 'L203', capacity: 10 },
    { room: 'L204', capacity: 12 },
    { room: 'L205', capacity: 15 }
  ],
  Engineering: [
    { room: 'E101', capacity: 5 },
    { room: 'E102', capacity: 7 },
    { room: 'E103', capacity: 9 },
    { room: 'E104', capacity: 12 },
    { room: 'E105', capacity: 15 }
  ],
  Science: [
    { room: 'S301', capacity: 5 },
    { room: 'S302', capacity: 6 },
    { room: 'S303', capacity: 8 },
    { room: 'S304', capacity: 10 },
    { room: 'S305', capacity: 14 }
  ],
  Business: [
    { room: 'B401', capacity: 5 },
    { room: 'B402', capacity: 6 },
    { room: 'B403', capacity: 9 },
    { room: 'B404', capacity: 11 },
    { room: 'B405', capacity: 15 }
  ],
  'Student Center': [
    { room: 'SC501', capacity: 5 },
    { room: 'SC502', capacity: 7 },
    { room: 'SC503', capacity: 8 },
    { room: 'SC504', capacity: 12 },
    { room: 'SC505', capacity: 15 }
  ]
};

const ALL_BUILDINGS = Object.keys(INVENTORY);
const NAME_MAP = Object.fromEntries(ALL_BUILDINGS.map(b => [b.toLowerCase(), b]));
const normalizeBuilding = v => (v ? NAME_MAP[String(v).trim().toLowerCase()] : null);


function overlaps(existingStart, existingEnd, newStart, newEnd) {
  const es = new Date(existingStart).getTime();
  const ee = new Date(existingEnd).getTime();
  const ns = new Date(newStart).getTime();
  const ne = new Date(newEnd).getTime();
  return (ns < ee) && (es < ne);
}

const ALL_BUILDINGS = Object.keys(INVENTORY);

async function findAvailableRoom(buildingOrNull, groupSize, startISO, endISO, opts = {}) {
  const strict = !!opts.strict;
  const buildingsToTry = buildingOrNull
    ? (strict ? [buildingOrNull] : [buildingOrNull].concat(ALL_BUILDINGS.filter(b => b !== buildingOrNull)))
    : ALL_BUILDINGS.slice();

  for (const b of buildingsToTry) {
    const rooms = (INVENTORY[b] || []).filter(r => r.capacity >= groupSize);
    if (rooms.length === 0) continue;

    const res = await pool.query(
      `SELECT room, start_time, end_time FROM reservations
       WHERE building = $1
         AND NOT (end_time <= $2 OR start_time >= $3)`,
      [b, startISO, endISO]
    );
    const taken = res.rows || [];

    for (const r of rooms) {
      const conflict = taken.some(t => t.room === r.room && overlaps(t.start_time, t.end_time, startISO, endISO));
      if (!conflict) {
        return { building: b, room: r.room, capacity: r.capacity };
      }
    }
  }
  return null;
}

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL env var");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false } 
});

// create table if not exists
const ensureSchema = async () => {
  // gen_random_uuid() needs pgcrypto
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      reservation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       TEXT NOT NULL,
      building      TEXT NOT NULL,
      room          TEXT NOT NULL,
      group_size    INT,
      start_time    TIMESTAMPTZ NOT NULL,
      end_time      TIMESTAMPTZ NOT NULL,
      equipment     TEXT, -- JSON as text or comma list
      status        TEXT NOT NULL DEFAULT 'CONFIRMED',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};
ensureSchema().catch(err => {
  console.error("Schema init error:", err);
  process.exit(1);
});

const ok = (res, data) => res.status(200).json(data);
const bad = (res, code, msg) => res.status(code).json({ error: msg });

app.get("/", (req, res) => ok(res, { ok: true, service: "room-reservations" }));

app.post("/reserve", async (req, res) => {
  try {
    const { userId, building, groupSize, startTime, endTime, equipment } = req.body;
    if (!userId || !groupSize || !startTime || !endTime) {
      return res.status(400).json({ error: "userId, groupSize, startTime, endTime are required" });
    }
    const gs = Number(groupSize);
    if (!Number.isFinite(gs) || gs <= 0) {
      return res.status(400).json({ error: "groupSize must be a positive number" });
    }

    const chosen = await findAvailableRoom(building, gs, startTime, endTime, { strict });
    if (!chosen) {
      return res.status(200).json({ error: "No room available for that size and time across buildings" });
    }

    const result = await pool.query(
      `INSERT INTO reservations (user_id, building, room, group_size, start_time, end_time, equipment)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [userId, normalizeBuilding(chosen.building), chosen.room, gs, startTime, endTime, equipment || null]
    );

    const row = result.rows[0];
    res.status(200).json(row);
  } catch (e) {
    console.error("Reserve error:", e);
    res.status(400).json({ error: e.message });
  }
});


app.get("/get", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return bad(res, 400, "id is required");

    const result = await pool.query(
      `SELECT * FROM reservations WHERE reservation_id = $1`,
      [id]
    );
    if (result.rowCount === 0) return bad(res, 404, "Reservation not found");
    ok(res, result.rows[0]);
  } catch (e) {
    console.error(e);
    bad(res, 400, e.message);
  }
});

app.get("/availability2", async (req, res) => {
  try {
    const buildingRaw = req.query.building || null;
    const building = normalizeBuilding(buildingRaw);
    const start     = req.query.start;
    const end       = req.query.end;
    const groupSize = Number(req.query.groupSize);
    const strict    = String(req.query.strict).toLowerCase() === 'true';

    if (!start || !end || !Number.isFinite(groupSize) || groupSize <= 0) {
      return res.status(400).json({ error: "start, end, groupSize are required" });
    }

    const chosen = await findAvailableRoom(building, groupSize, start, end, { strict });
    if (!chosen) return res.status(200).json({ available: false });

    return res.status(200).json({
      available: true,
      building: chosen.building,
      room: chosen.room,
      capacity: chosen.capacity
    });
  } catch (e) {
    console.error("Availability2 error:", e);
    res.status(400).json({ error: e.message });
  }
});

app.post("/update", async (req, res) => {
  try {
    const { reservationId, updates } = req.body;
    if (!reservationId || !updates || typeof updates !== "object") {
      return bad(res, 400, "reservationId and updates object are required");
    }

    const allowed = ["building","room","groupSize","startTime","endTime","equipment","status"];
    const keys = Object.keys(updates).filter(k => allowed.includes(k));
    if (keys.length === 0) return bad(res, 400, "No valid fields to update");

    // build dynamic SET clause
    const setParts = ["updated_at = NOW()"];
    const values = [];
    let idx = 1;

    for (const k of keys) {
      let col = {
        building: "building",
        room: "room",
        groupSize: "group_size",
        startTime: "start_time",
        endTime: "end_time",
        equipment: "equipment",
        status: "status"
      }[k];

      setParts.push(`${col} = $${++idx}`);
      values.push(col === "group_size" ? Number(updates[k]) : updates[k]);
    }

    const sql = `
      UPDATE reservations
      SET ${setParts.join(", ")}
      WHERE reservation_id = $1
      RETURNING *;
    `;

    const result = await pool.query(sql, [reservationId, ...values]);
    if (result.rowCount === 0) return bad(res, 404, "Reservation not found");
    ok(res, result.rows[0]);
  } catch (e) {
    console.error(e);
    bad(res, 400, e.message);
  }
});

app.post("/cancel", async (req, res) => {
  try {
    const { reservationId } = req.body;
    if (!reservationId) return bad(res, 400, "reservationId is required");

    const result = await pool.query(
      `DELETE FROM reservations WHERE reservation_id = $1 RETURNING reservation_id`,
      [reservationId]
    );
    if (result.rowCount === 0) return bad(res, 404, "Reservation not found");
    ok(res, { deleted: true, reservationId });
  } catch (e) {
    console.error(e);
    bad(res, 400, e.message);
  }
});

const TZ = process.env.TZ || "America/Los_Angeles";

function fmtRange(startISO, endISO) {
  const s = new Date(startISO);
  const e = new Date(endISO);
  const datePart = s.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: TZ });
  const timeStart = s.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
  const timeEnd   = e.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
  return `${datePart}, ${timeStart}–${timeEnd}`;
}

function numberWord(n) {
  // 1->"one", 2->"two" for nicer prompts (fallback to number)
  const words = ["zero","one","two","three","four","five","six","seven","eight","nine","ten"];
  return (n >= 0 && n < words.length) ? words[n] : String(n);
}
app.get("/reservations/upcoming", async (req, res) => {
  try {
    const { userId, days } = req.query;
    if (!userId) return bad(res, 400, "userId is required");
    const horizon = Number(days) > 0 ? Number(days) : 30;

    const { rows } = await pool.query(
      `SELECT reservation_id, building, room, group_size, start_time, end_time, status
         FROM reservations
        WHERE user_id = $1
          AND start_time >= NOW()
          AND start_time <= NOW() + ($2 || ' days')::interval
        ORDER BY start_time ASC`,
      [userId, horizon]
    );
    let speech = "";
    if (rows.length === 0) {
      speech = "I don’t see any upcoming reservations for you.";
    } else if (rows.length === 1) {
      const r = rows[0];
      speech = `You have one upcoming reservation: ${r.building} ${r.room}, ${fmtRange(r.start_time, r.end_time)} for ${r.group_size} people. Say “cancel it” to remove this booking, or “keep it” to leave it as is.`;
    } else {
      const parts = rows.slice(0, 5).map((r, i) =>
        `${i + 1}) ${r.building} ${r.room}, ${fmtRange(r.start_time, r.end_time)}`
      );
      const more = rows.length > 5 ? ` I’m only reading the first five of ${rows.length}.` : "";
      speech = `You have ${rows.length} upcoming reservations. ${parts.join(". ")}.${more} Say “cancel ${numberWord(1)}”, “cancel ${numberWord(2)}”, and so on.`;
    }

    ok(res, { items: rows, speech });
  } catch (e) {
    bad(res, 400, e.message);
  }
});

app.post("/cancel/by-user", async (req, res) => {
  try {
    const { userId, pickIndex } = req.body;
    if (!userId || pickIndex === undefined || pickIndex === null) {
      return bad(res, 400, "userId and pickIndex are required");
    }
    const idx = Number(pickIndex) - 1;
    if (!Number.isInteger(idx) || idx < 0) {
      return bad(res, 400, "pickIndex must be a positive integer");
    }

    const { rows } = await pool.query(
      `SELECT reservation_id, building, room, group_size, start_time, end_time
         FROM reservations
        WHERE user_id = $1 AND start_time >= NOW()
        ORDER BY start_time ASC`,
      [userId]
    );

    if (rows.length === 0) {
      return ok(res, { deleted: false, speech: "You don’t have any upcoming reservations to cancel." });
    }
    if (idx >= rows.length) {
      return bad(res, 404, "Selection not found");
    }

    const chosen = rows[idx];
    const del = await pool.query(
      `DELETE FROM reservations WHERE reservation_id = $1 AND user_id = $2 RETURNING reservation_id`,
      [chosen.reservation_id, userId]
    );

    if (del.rowCount === 0) {
      return bad(res, 404, "Reservation not found");
    }

    const speech = `Canceled: ${chosen.building} ${chosen.room}, ${fmtRange(chosen.start_time, chosen.end_time)} for ${chosen.group_size} people. Do you want to cancel anything else?`;
    ok(res, { deleted: true, reservationId: del.rows[0].reservation_id, speech });
  } catch (e) {
    bad(res, 400, e.message);
  }
});

app.get("/list", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return bad(res, 400, "userId is required");

    const result = await pool.query(
      `SELECT * FROM reservations WHERE user_id = $1 ORDER BY start_time ASC`,
      [userId]
    );
    ok(res, { items: result.rows });
  } catch (e) {
    console.error(e);
    bad(res, 400, e.message);
  }
});

app.listen(PORT, () => {
  console.log(`Server on :${PORT}`);
});
