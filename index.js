import express from "express";
import cors from "cors";
import pkg from "pg";

const { Pool } = pkg;

const app = express();
app.use(express.json());
app.use(cors({ origin: "*"})); // tighten this later if you want

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL env var");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

// create table if not exists
const ensureSchema = async () => {
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

  // gen_random_uuid() needs pgcrypto
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
};
ensureSchema().catch(err => {
  console.error("Schema init error:", err);
  process.exit(1);
});

const ok = (res, data) => res.status(200).json(data);
const bad = (res, code, msg) => res.status(code).json({ error: msg });

// routes
app.get("/", (req, res) => ok(res, { ok: true, service: "room-reservations" }));

app.post("/reserve", async (req, res) => {
  try {
    const { userId, building, room, groupSize, startTime, endTime, equipment } = req.body;
    if (!userId || !building || !room || !startTime || !endTime) {
      return bad(res, 400, "Missing required fields: userId, building, room, startTime, endTime");
    }

    const result = await pool.query(
      `INSERT INTO reservations (user_id, building, room, group_size, start_time, end_time, equipment)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [userId, building, room, groupSize ?? null, startTime, endTime, equipment ?? null]
    );

    ok(res, result.rows[0]);
  } catch (e) {
    console.error(e);
    bad(res, 400, e.message);
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
