import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

/* SQLite intégré à Node : transactionnel, un seul fichier, aucune dépendance. */
const file = path.resolve(process.cwd(), config.databaseFile);
if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

/* ---------- Migrations ---------- */

const MIGRATIONS = [
  {
    id: 1,
    name: "schéma initial",
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'free',
        subscription_status TEXT,
        subscription_id TEXT,
        customer_id TEXT,
        current_period_end TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX sessions_user ON sessions(user_id);
      CREATE TABLE appointments (
        id TEXT PRIMARY KEY,
        reference TEXT NOT NULL UNIQUE,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        doctor_id TEXT NOT NULL,
        doctor_name TEXT NOT NULL,
        speciality TEXT NOT NULL,
        slot TEXT NOT NULL,
        patient_name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        reason TEXT,
        tier TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (doctor_id, slot)
      );
      CREATE TABLE history (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        target TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX history_user ON history(user_id, created_at DESC);
      CREATE TABLE processed_events (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
    `,
  },
];

export function migrate() {
  db.exec("CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
  const done = new Set(db.prepare("SELECT id FROM migrations").all().map((row) => row.id));
  for (const migration of MIGRATIONS) {
    if (done.has(migration.id)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

/* ---------- Utilisateurs ---------- */

export const users = {
  byEmail(email) {
    return db.prepare("SELECT * FROM users WHERE email = ?").get(email) ?? null;
  },
  byId(id) {
    return db.prepare("SELECT * FROM users WHERE id = ?").get(id) ?? null;
  },
  byCustomerId(customerId) {
    return db.prepare("SELECT * FROM users WHERE customer_id = ?").get(customerId) ?? null;
  },
  create({ email, name, password, tier = "free" }) {
    const id = uuid();
    db.prepare(
      `INSERT INTO users (id, email, name, password, tier, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, email, name, password, tier, now());
    return this.byId(id);
  },
  setSubscription(userId, { tier, status, subscriptionId, customerId, currentPeriodEnd }) {
    db.prepare(
      `UPDATE users SET tier = ?, subscription_status = ?, subscription_id = ?,
       customer_id = COALESCE(?, customer_id), current_period_end = ? WHERE id = ?`,
    ).run(tier, status ?? null, subscriptionId ?? null, customerId ?? null, currentPeriodEnd ?? null, userId);
    return this.byId(userId);
  },
  setCustomerId(userId, customerId) {
    db.prepare("UPDATE users SET customer_id = ? WHERE id = ?").run(customerId, userId);
  },
};

/* ---------- Sessions ---------- */

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

export const sessions = {
  create(userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + config.limits.sessionDays * 86_400_000).toISOString();
    db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
      hashToken(token),
      userId,
      now(),
      expires,
    );
    return token;
  },
  user(token) {
    if (!token) return null;
    const row = db
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(hashToken(token), now());
    return row ?? null;
  },
  destroy(token) {
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  },
  destroyAllFor(userId) {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  },
  prune() {
    return db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now()).changes;
  },
};

/* ---------- Rendez-vous ---------- */

export const appointments = {
  bookedSlots(doctorId) {
    return new Set(
      db.prepare("SELECT slot FROM appointments WHERE doctor_id = ?").all(doctorId).map((row) => row.slot),
    );
  },
  allBooked() {
    return db.prepare("SELECT doctor_id, slot FROM appointments").all();
  },
  forUser(userId) {
    return db
      .prepare("SELECT * FROM appointments WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId);
  },
  /** La contrainte UNIQUE(doctor_id, slot) fait office de verrou : deux
   *  réservations simultanées du même créneau ne peuvent pas passer. */
  create(input) {
    const id = uuid();
    const reference = `DRDU-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    try {
      db.prepare(
        `INSERT INTO appointments (id, reference, user_id, doctor_id, doctor_name, speciality, slot,
          patient_name, email, phone, reason, tier, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        reference,
        input.userId ?? null,
        input.doctorId,
        input.doctorName,
        input.speciality,
        input.slot,
        input.patientName,
        input.email,
        input.phone ?? null,
        input.reason ?? null,
        input.tier,
        now(),
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        throw Object.assign(new Error("Créneau plus disponible."), { status: 409 });
      }
      throw error;
    }
    return db.prepare("SELECT * FROM appointments WHERE id = ?").get(id);
  },
};

/* ---------- Historique ---------- */

export const history = {
  forUser(userId) {
    return db
      .prepare("SELECT * FROM history WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId)
      .map(inflate);
  },
  get(userId, id) {
    const row = db.prepare("SELECT * FROM history WHERE id = ? AND user_id = ?").get(id, userId);
    return row ? inflate(row) : null;
  },
  save(userId, result) {
    const id = uuid();
    db.exec("BEGIN");
    try {
      db.prepare(
        "INSERT INTO history (id, user_id, file_name, target, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, userId, result.fileName ?? "document", result.target, JSON.stringify(result), now());
      // Éviction des plus anciens au-delà du quota.
      db.prepare(
        `DELETE FROM history WHERE user_id = ? AND id NOT IN (
           SELECT id FROM history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
         )`,
      ).run(userId, userId, config.limits.historyPerUser);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return this.get(userId, id);
  },
  remove(userId, id) {
    return db.prepare("DELETE FROM history WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
  },
};

function inflate(row) {
  const payload = JSON.parse(row.payload);
  return {
    id: row.id,
    createdAt: row.created_at,
    fileName: row.file_name,
    target: row.target,
    document_type: payload.document_type ?? "",
    translation: payload.translation ?? "",
    summary: payload.summary ?? "",
    cautions: payload.cautions ?? [],
    glossary: payload.glossary ?? [],
    questions_for_doctor: payload.questions_for_doctor ?? [],
    follow_up: payload.follow_up ?? [],
  };
}

/* ---------- Idempotence des webhooks ---------- */

export const events = {
  /** true si l'événement est nouveau ; false s'il a déjà été traité. */
  claim(id) {
    try {
      db.prepare("INSERT INTO processed_events (id, created_at) VALUES (?, ?)").run(id, now());
      return true;
    } catch {
      return false;
    }
  },
};
