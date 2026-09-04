import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

/* SQLite intégré à Node : transactionnel, un seul fichier, aucune dépendance. */
// « :memory: » est un mot-clé SQLite, pas un chemin : il ne doit pas être résolu,
// sinon un fichier de ce nom apparaît à la racine du projet.
const inMemory = config.databaseFile === ":memory:";
const file = inMemory ? ":memory:" : path.resolve(process.cwd(), config.databaseFile);
if (!inMemory) fs.mkdirSync(path.dirname(file), { recursive: true });

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
  {
    id: 2,
    name: "service de traduction seule : abandon des rendez-vous",
    sql: `DROP TABLE IF EXISTS appointments;`,
  },
  {
    id: 3,
    name: "plateforme : commerçants, prestations, créneaux, réservations",
    sql: `
      ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'customer';
      ALTER TABLE users ADD COLUMN locale TEXT NOT NULL DEFAULT 'fr';

      CREATE TABLE merchants (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        address TEXT NOT NULL,
        city TEXT NOT NULL,
        postal_code TEXT NOT NULL,
        phone TEXT NOT NULL,
        languages TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX merchants_public ON merchants(status, city, category);

      CREATE TABLE services (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        duration_min INTEGER NOT NULL,
        price_cents INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE INDEX services_merchant ON services(merchant_id, active);

      -- Un créneau appartient au commerçant ; il porte la prestation lorsqu'il
      -- lui est réservé, sinon il vaut pour toutes les prestations.
      CREATE TABLE slots (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        service_id TEXT REFERENCES services(id) ON DELETE CASCADE,
        starts_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (merchant_id, starts_at, service_id)
      );
      CREATE INDEX slots_open ON slots(merchant_id, starts_at);

      CREATE TABLE bookings (
        id TEXT PRIMARY KEY,
        reference TEXT NOT NULL UNIQUE,
        slot_id TEXT NOT NULL UNIQUE REFERENCES slots(id) ON DELETE CASCADE,
        merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        starts_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'confirmed',
        note TEXT NOT NULL DEFAULT '',
        note_lang TEXT NOT NULL DEFAULT 'fr',
        created_at TEXT NOT NULL,
        cancelled_at TEXT,
        cancelled_by TEXT
      );
      CREATE INDEX bookings_merchant ON bookings(merchant_id, starts_at);
      CREATE INDEX bookings_customer ON bookings(customer_id, starts_at);

      CREATE TABLE booking_messages (
        id TEXT PRIMARY KEY,
        booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sender_role TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read_at TEXT
      );
      CREATE INDEX booking_messages_thread ON booking_messages(booking_id, created_at);

      -- Cache de traduction : une même phrase n'est jamais payée deux fois.
      CREATE TABLE translations (
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        target TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (subject_kind, subject_id, target)
      );
    `,
  },
  {
    id: 4,
    name: "unicité réelle des créneaux (NULL n'est pas égal à NULL en SQL)",
    sql: `
      -- Deux NULL étant distincts pour une contrainte UNIQUE, un créneau sans
      -- prestation pouvait être ouvert plusieurs fois. L'index d'expression
      -- ramène ces cas à une chaîne vide, donc comparable.
      DELETE FROM slots WHERE id NOT IN (
        SELECT MIN(id) FROM slots GROUP BY merchant_id, starts_at, COALESCE(service_id, '')
      );
      CREATE UNIQUE INDEX slots_unique_moment
        ON slots(merchant_id, starts_at, COALESCE(service_id, ''));
    `,
  },
  {
    id: 5,
    name: "modération des établissements et réinitialisation de mot de passe",
    sql: `
      ALTER TABLE merchants ADD COLUMN moderation_note TEXT NOT NULL DEFAULT '';
      ALTER TABLE merchants ADD COLUMN reviewed_at TEXT;

      CREATE TABLE password_resets (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE INDEX password_resets_user ON password_resets(user_id);
    `,
  },
  {
    id: 6,
    name: "un créneau annulé redevient réservable ; une prestation réservée ne se supprime pas",
    // Reconstruction de table : impossible dans une transaction avec les clés
    // étrangères actives (le DROP déclencherait les suppressions en cascade).
    rebuild: true,
    sql: `
      CREATE TABLE bookings_new (
        id TEXT PRIMARY KEY,
        reference TEXT NOT NULL UNIQUE,
        slot_id TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
        merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        service_id TEXT NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
        customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        starts_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'confirmed',
        note TEXT NOT NULL DEFAULT '',
        note_lang TEXT NOT NULL DEFAULT 'fr',
        created_at TEXT NOT NULL,
        cancelled_at TEXT,
        cancelled_by TEXT
      );
      INSERT INTO bookings_new SELECT id, reference, slot_id, merchant_id, service_id, customer_id,
        starts_at, status, note, note_lang, created_at, cancelled_at, cancelled_by FROM bookings;
      DROP TABLE bookings;
      ALTER TABLE bookings_new RENAME TO bookings;
      CREATE INDEX bookings_merchant ON bookings(merchant_id, starts_at);
      CREATE INDEX bookings_customer ON bookings(customer_id, starts_at);
      -- Le verrou ne porte que sur les réservations en cours : une annulation
      -- libère réellement le créneau.
      CREATE UNIQUE INDEX bookings_slot_confirmed ON bookings(slot_id) WHERE status = 'confirmed';
    `,
  },
];

export function migrate() {
  db.exec("CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
  const done = new Set(db.prepare("SELECT id FROM migrations").all().map((row) => row.id));
  for (const migration of MIGRATIONS) {
    if (done.has(migration.id)) continue;
    // Une reconstruction de table coupe les clés étrangères le temps de
    // l'opération, puis vérifie qu'aucune référence n'a été cassée.
    if (migration.rebuild) db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      if (migration.rebuild) {
        const broken = db.prepare("PRAGMA foreign_key_check").all();
        if (broken.length) throw new Error(`Références cassées par la migration ${migration.id}`);
      }
      db.prepare("INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      if (migration.rebuild) db.exec("PRAGMA foreign_keys = ON");
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
  setLocale(userId, locale) {
    db.prepare("UPDATE users SET locale = ? WHERE id = ?").run(locale, userId);
    return this.byId(userId);
  },
  setPassword(userId, password) {
    db.prepare("UPDATE users SET password = ? WHERE id = ?").run(password, userId);
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


/* ---------- Commerçants ---------- */

export const CATEGORIES = {
  beaute: "Beauté et coiffure",
  bienetre: "Bien-être et massage",
  juridique: "Juridique, comptable et fiscal",
  formation: "Cours et formation",
  reparation: "Réparation et entretien",
  demarches: "Aide aux démarches administratives",
  autre: "Autre service",
};

export const merchants = {
  byId(id) {
    const row = db.prepare("SELECT * FROM merchants WHERE id = ?").get(id);
    return row ? inflateMerchant(row) : null;
  },
  byOwner(ownerId) {
    const row = db.prepare("SELECT * FROM merchants WHERE owner_id = ?").get(ownerId);
    return row ? inflateMerchant(row) : null;
  },

  create(ownerId, input) {
    if (this.byOwner(ownerId)) {
      throw Object.assign(new Error("Un établissement est déjà rattaché à ce compte."), { status: 409 });
    }
    const id = uuid();
    const timestamp = now();
    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT INTO merchants (id, owner_id, name, category, description, address, city, postal_code,
          phone, languages, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        ownerId,
        input.name,
        input.category,
        input.description,
        input.address,
        input.city,
        input.postalCode,
        input.phone,
        JSON.stringify(input.languages),
        input.status,
        timestamp,
        timestamp,
      );
      db.prepare("UPDATE users SET role = 'merchant' WHERE id = ?").run(ownerId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return this.byId(id);
  },

  update(id, input) {
    db.prepare(
      `UPDATE merchants SET name = ?, category = ?, description = ?, address = ?, city = ?,
       postal_code = ?, phone = ?, languages = ?, updated_at = ? WHERE id = ?`,
    ).run(
      input.name,
      input.category,
      input.description,
      input.address,
      input.city,
      input.postalCode,
      input.phone,
      JSON.stringify(input.languages),
      now(),
      id,
    );
    return this.byId(id);
  },

  /** Statuts possibles d'une fiche, du dépôt à la publication. */
  STATUSES: ["pending", "active", "paused", "suspended", "rejected"],
  /** Statuts que le commerçant peut modifier lui-même. */
  SELF_SERVICE: ["active", "paused"],

  setStatus(id, status, note = "") {
    if (!merchants.STATUSES.includes(status)) {
      throw Object.assign(new Error("Statut inconnu."), { status: 400 });
    }
    db.prepare(
      "UPDATE merchants SET status = ?, moderation_note = ?, reviewed_at = ?, updated_at = ? WHERE id = ?",
    ).run(status, note, now(), now(), id);
    return this.byId(id);
  },

  /** Vue de modération : toutes les fiches, ou celles d'un statut donné. */
  forModeration(status = null) {
    const rows = status
      ? db.prepare("SELECT * FROM merchants WHERE status = ? ORDER BY created_at").all(status)
      : db.prepare("SELECT * FROM merchants ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at").all();
    return rows.map((row) => {
      const merchant = inflateMerchant(row);
      const owner = users.byId(row.owner_id);
      return {
        ...merchant,
        moderationNote: row.moderation_note,
        reviewedAt: row.reviewed_at,
        owner: owner ? { name: owner.name, email: owner.email } : null,
        services: services.forMerchant(merchant.id).length,
      };
    });
  },

  counts() {
    const rows = db.prepare("SELECT status, COUNT(*) AS n FROM merchants GROUP BY status").all();
    return Object.fromEntries(rows.map((row) => [row.status, row.n]));
  },

  /** Catalogue public : établissements actifs, filtrables par ville et catégorie. */
  catalog({ city, category, limit = 40 } = {}) {
    const clauses = ["status = 'active'"];
    const params = [];
    if (city) {
      clauses.push("LOWER(city) = LOWER(?)");
      params.push(city);
    }
    if (category) {
      clauses.push("category = ?");
      params.push(category);
    }
    return db
      .prepare(`SELECT * FROM merchants WHERE ${clauses.join(" AND ")} ORDER BY name LIMIT ?`)
      .all(...params, limit)
      .map(inflateMerchant)
      .map(publicMerchant)
      .map((merchant) => ({
        ...merchant,
        services: services.forMerchant(merchant.id, { onlyActive: true }),
        openSlots: slots.openCount(merchant.id),
      }));
  },

  cities() {
    return db
      .prepare("SELECT city, COUNT(*) AS n FROM merchants WHERE status = 'active' GROUP BY city ORDER BY n DESC")
      .all()
      .map((row) => row.city);
  },

  validate(input) {
    const errors = [];
    const text = (value, max) => String(value ?? "").trim().slice(0, max);
    const name = text(input.name, 120);
    const description = text(input.description, 2000);
    const address = text(input.address, 160);
    const city = text(input.city, 80);
    const postalCode = text(input.postalCode, 12);
    const phone = text(input.phone, 30);
    const languages = (Array.isArray(input.languages) ? input.languages : []).filter(Boolean).slice(0, 8);
    if (!name) errors.push("nom de l'établissement");
    if (!Object.hasOwn(CATEGORIES, input.category)) errors.push("catégorie");
    if (description.length < 20) errors.push("description (20 caractères minimum)");
    if (!address) errors.push("adresse");
    if (!city) errors.push("ville");
    if (!/^[0-9A-Za-z -]{4,12}$/.test(postalCode)) errors.push("code postal");
    if (!/^[+0-9 ().-]{6,30}$/.test(phone)) errors.push("téléphone");
    if (!languages.length) errors.push("langues parlées");
    if (errors.length) {
      throw Object.assign(new Error(`Champs à compléter : ${errors.join(", ")}.`), { status: 400 });
    }
    return {
      name,
      category: input.category,
      description,
      address,
      city,
      postalCode,
      phone,
      languages: languages.map((l) => String(l).slice(0, 24)),
    };
  },
};

/** Ce que le public voit d'une fiche : ni le compte propriétaire, ni la modération. */
export function publicMerchant(merchant) {
  if (!merchant) return null;
  const { ownerId, moderationNote, ...visible } = merchant;
  return visible;
}

function inflateMerchant(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    category: row.category,
    categoryLabel: CATEGORIES[row.category] ?? row.category,
    description: row.description,
    address: row.address,
    city: row.city,
    postalCode: row.postal_code,
    phone: row.phone,
    languages: JSON.parse(row.languages),
    status: row.status,
    moderationNote: row.moderation_note ?? "",
    createdAt: row.created_at,
  };
}

/* ---------- Prestations ---------- */

export const services = {
  byId(id) {
    const row = db.prepare("SELECT * FROM services WHERE id = ?").get(id);
    return row ? inflateService(row) : null;
  },
  forMerchant(merchantId, { onlyActive = false } = {}) {
    const sql = onlyActive
      ? "SELECT * FROM services WHERE merchant_id = ? AND active = 1 ORDER BY name"
      : "SELECT * FROM services WHERE merchant_id = ? ORDER BY name";
    return db.prepare(sql).all(merchantId).map(inflateService);
  },
  create(merchantId, input) {
    const id = uuid();
    db.prepare(
      `INSERT INTO services (id, merchant_id, name, description, duration_min, price_cents, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(id, merchantId, input.name, input.description, input.durationMin, input.priceCents, now());
    return this.byId(id);
  },
  update(id, input) {
    db.prepare(
      "UPDATE services SET name = ?, description = ?, duration_min = ?, price_cents = ?, active = ? WHERE id = ?",
    ).run(input.name, input.description, input.durationMin, input.priceCents, input.active ? 1 : 0, id);
    return this.byId(id);
  },
  /**
   * Une prestation qui a servi — même à une réservation annulée — fait partie de
   * l'historique des clients et ne se supprime pas : on la désactive. La clé
   * étrangère (ON DELETE RESTRICT) garantit la même règle côté base.
   */
  remove(merchantId, id) {
    const { active, total } = db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS active
         FROM bookings WHERE service_id = ?`,
      )
      .get(id);
    if (total) {
      const detail = active
        ? `${active} réservation(s) en cours`
        : `${total} réservation(s) passée(s) dans l'historique des clients`;
      throw Object.assign(
        new Error(`Cette prestation a ${detail} : désactivez-la plutôt que de la supprimer.`),
        { status: 409 },
      );
    }
    return db.prepare("DELETE FROM services WHERE id = ? AND merchant_id = ?").run(id, merchantId).changes > 0;
  },
  validate(input) {
    const name = String(input.name ?? "").trim().slice(0, 120);
    const duration = Number(input.durationMin);
    const price = Math.round(Number(input.priceCents ?? 0));
    const errors = [];
    if (!name) errors.push("nom de la prestation");
    if (!Number.isInteger(duration) || duration < 5 || duration > 600) errors.push("durée (5 à 600 minutes)");
    if (!Number.isInteger(price) || price < 0 || price > 10_000_00) errors.push("prix");
    if (errors.length) {
      throw Object.assign(new Error(`Champs à compléter : ${errors.join(", ")}.`), { status: 400 });
    }
    return {
      name,
      description: String(input.description ?? "").trim().slice(0, 1000),
      durationMin: duration,
      priceCents: price,
      active: input.active !== false,
    };
  },
};

function inflateService(row) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    name: row.name,
    description: row.description,
    durationMin: row.duration_min,
    priceCents: row.price_cents,
    active: Boolean(row.active),
  };
}

/* ---------- Créneaux ---------- */

export const slots = {
  /** Ouvre des créneaux ; ceux qui existent déjà sont ignorés sans erreur. */
  open(merchantId, startsAtList, serviceId = null) {
    const insert = db.prepare(
      `INSERT INTO slots (id, merchant_id, service_id, starts_at, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    );
    let created = 0;
    db.exec("BEGIN");
    try {
      for (const startsAt of startsAtList) {
        created += insert.run(uuid(), merchantId, serviceId, startsAt, now()).changes;
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return created;
  },

  /** Créneaux libres à venir : ceux qui ne portent pas de réservation active. */
  available(merchantId, { serviceId = null, from = now() } = {}) {
    return db
      .prepare(
        `SELECT s.* FROM slots s
         LEFT JOIN bookings b ON b.slot_id = s.id AND b.status = 'confirmed'
         WHERE s.merchant_id = ? AND s.starts_at > ? AND b.id IS NULL
           AND (s.service_id IS NULL OR s.service_id = COALESCE(?, s.service_id))
         ORDER BY s.starts_at`,
      )
      .all(merchantId, from, serviceId)
      .map((row) => ({ id: row.id, startsAt: row.starts_at, serviceId: row.service_id }));
  },

  openCount(merchantId) {
    return db
      .prepare(
        `SELECT COUNT(*) AS n FROM slots s
         LEFT JOIN bookings b ON b.slot_id = s.id AND b.status = 'confirmed'
         WHERE s.merchant_id = ? AND s.starts_at > ? AND b.id IS NULL`,
      )
      .get(merchantId, now()).n;
  },

  forMerchant(merchantId, { from = now() } = {}) {
    return db
      .prepare(
        `SELECT s.*, b.id AS booking_id, b.reference FROM slots s
         LEFT JOIN bookings b ON b.slot_id = s.id AND b.status = 'confirmed'
         WHERE s.merchant_id = ? AND s.starts_at > ? ORDER BY s.starts_at`,
      )
      .all(merchantId, from)
      .map((row) => ({
        id: row.id,
        startsAt: row.starts_at,
        serviceId: row.service_id,
        booked: Boolean(row.booking_id),
        reference: row.reference ?? null,
      }));
  },

  remove(merchantId, id) {
    const booked = db
      .prepare("SELECT id FROM bookings WHERE slot_id = ? AND status = 'confirmed'")
      .get(id);
    if (booked) throw Object.assign(new Error("Ce créneau est réservé : annulez la réservation d'abord."), { status: 409 });
    return db.prepare("DELETE FROM slots WHERE id = ? AND merchant_id = ?").run(id, merchantId).changes > 0;
  },
};

/* ---------- Réservations ---------- */

export const bookings = {
  byId(id) {
    const row = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
    return row ? inflateBooking(row) : null;
  },

  /**
   * Réserve un créneau. La contrainte UNIQUE sur slot_id sert de verrou : deux
   * clients ne peuvent pas prendre le même créneau, même simultanément.
   */
  create({ slotId, customerId, serviceId, note, noteLang }) {
    const slot = db.prepare("SELECT * FROM slots WHERE id = ?").get(slotId);
    if (!slot) throw Object.assign(new Error("Créneau introuvable."), { status: 404 });
    // Une fiche hors catalogue (en attente, en pause, suspendue, refusée) ne
    // reçoit pas de réservation, même avec un identifiant de créneau connu.
    const merchant = merchants.byId(slot.merchant_id);
    if (!merchant || merchant.status !== "active") {
      throw Object.assign(new Error("Cet établissement n'accepte pas de réservation pour le moment."), { status: 409 });
    }
    if (slot.starts_at <= now()) throw Object.assign(new Error("Ce créneau est passé."), { status: 409 });
    const service = services.byId(serviceId);
    if (!service || service.merchantId !== slot.merchant_id || !service.active) {
      throw Object.assign(new Error("Prestation indisponible."), { status: 400 });
    }
    if (slot.service_id && slot.service_id !== serviceId) {
      throw Object.assign(new Error("Ce créneau ne correspond pas à cette prestation."), { status: 409 });
    }

    const id = uuid();
    const reference = `DR-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    try {
      db.prepare(
        `INSERT INTO bookings (id, reference, slot_id, merchant_id, service_id, customer_id, starts_at,
          status, note, note_lang, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`,
      ).run(
        id,
        reference,
        slotId,
        slot.merchant_id,
        serviceId,
        customerId,
        slot.starts_at,
        note ?? "",
        noteLang ?? "fr",
        now(),
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        throw Object.assign(new Error("Ce créneau vient d'être réservé."), { status: 409 });
      }
      throw error;
    }
    return this.byId(id);
  },

  forCustomer(customerId) {
    return db
      .prepare("SELECT * FROM bookings WHERE customer_id = ? ORDER BY starts_at DESC")
      .all(customerId)
      .map((row) => decorate(row, customerId));
  },

  /** @param readerId compte qui lit, pour ne compter que les messages reçus */
  forMerchant(merchantId, readerId) {
    return db
      .prepare("SELECT * FROM bookings WHERE merchant_id = ? ORDER BY starts_at")
      .all(merchantId)
      .map((row) => decorate(row, readerId));
  },

  /** Une réservation enrichie, telle que la voit un lecteur donné. */
  detailed(id, readerId) {
    const row = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
    return row ? decorate(row, readerId) : null;
  },

  /** Le client comme le commerçant peuvent annuler ; chacun sur son périmètre. */
  cancel(id, actor) {
    const booking = this.byId(id);
    if (!booking) throw Object.assign(new Error("Réservation introuvable."), { status: 404 });
    const allowed =
      booking.customerId === actor.userId || booking.merchantId === actor.merchantId;
    if (!allowed) throw Object.assign(new Error("Réservation introuvable."), { status: 404 });
    // Déjà annulée : rien ne change, et l'appelant ne doit pas renvoyer de courriel.
    if (booking.status !== "confirmed") return { ...booking, changed: false };
    db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = ? WHERE id = ?").run(
      now(),
      booking.customerId === actor.userId ? "customer" : "merchant",
      id,
    );
    // L'index unique ne porte que sur les réservations confirmées : le créneau
    // redevient réellement réservable.
    return { ...this.byId(id), changed: true };
  },

  /** Vérifie que le compte a accès à cette réservation, et à quel titre. */
  access(id, user, merchant) {
    const booking = this.byId(id);
    if (!booking) return null;
    if (booking.customerId === user.id) return { booking, role: "customer" };
    if (merchant && booking.merchantId === merchant.id) return { booking, role: "merchant" };
    return null;
  },
};

function inflateBooking(row) {
  return {
    id: row.id,
    reference: row.reference,
    slotId: row.slot_id,
    merchantId: row.merchant_id,
    serviceId: row.service_id,
    customerId: row.customer_id,
    startsAt: row.starts_at,
    status: row.status,
    note: row.note,
    noteLang: row.note_lang,
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
  };
}

/** Réservation enrichie du commerçant, de la prestation et du client. */
function decorate(row, readerId = null) {
  const booking = inflateBooking(row);
  const merchant = merchants.byId(booking.merchantId);
  const service = services.byId(booking.serviceId);
  const customer = users.byId(booking.customerId);
  // Seuls les messages reçus comptent comme non lus : les siens n'en sont jamais.
  const unread = db
    .prepare(
      "SELECT COUNT(*) AS n FROM booking_messages WHERE booking_id = ? AND read_at IS NULL AND sender_id != ?",
    )
    .get(booking.id, readerId ?? "").n;
  return {
    ...booking,
    merchant: merchant
      ? { id: merchant.id, name: merchant.name, city: merchant.city, address: merchant.address, phone: merchant.phone }
      : null,
    service: service ? { id: service.id, name: service.name, durationMin: service.durationMin, priceCents: service.priceCents } : null,
    customer: customer ? { id: customer.id, name: customer.name, email: customer.email, locale: customer.locale } : null,
    unread,
  };
}

/* ---------- Messages attachés à une réservation ---------- */

export const bookingMessages = {
  list(bookingId) {
    return db
      .prepare("SELECT * FROM booking_messages WHERE booking_id = ? ORDER BY created_at")
      .all(bookingId)
      .map((row) => ({
        id: row.id,
        senderId: row.sender_id,
        senderRole: row.sender_role,
        body: row.body,
        createdAt: row.created_at,
        readAt: row.read_at,
      }));
  },
  create(bookingId, senderId, senderRole, body) {
    const id = uuid();
    db.prepare(
      `INSERT INTO booking_messages (id, booking_id, sender_id, sender_role, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, bookingId, senderId, senderRole, body, now());
    return db.prepare("SELECT * FROM booking_messages WHERE id = ?").get(id);
  },
  markRead(bookingId, readerId) {
    return db
      .prepare("UPDATE booking_messages SET read_at = ? WHERE booking_id = ? AND sender_id != ? AND read_at IS NULL")
      .run(now(), bookingId, readerId).changes;
  },
};

/* ---------- Cache de traduction ---------- */

export const translations = {
  get(kind, subjectId, target) {
    const row = db
      .prepare("SELECT payload FROM translations WHERE subject_kind = ? AND subject_id = ? AND target = ?")
      .get(kind, subjectId, target);
    return row ? JSON.parse(row.payload) : null;
  },
  put(kind, subjectId, target, payload) {
    db.prepare(
      `INSERT INTO translations (subject_kind, subject_id, target, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (subject_kind, subject_id, target) DO UPDATE SET payload = excluded.payload`,
    ).run(kind, subjectId, target, JSON.stringify(payload), now());
    return payload;
  },
  invalidate(kind, subjectId) {
    db.prepare("DELETE FROM translations WHERE subject_kind = ? AND subject_id = ?").run(kind, subjectId);
  },
};

/* ---------- Réinitialisation de mot de passe ---------- */

export const passwordResets = {
  /**
   * Crée un jeton à usage unique. Seul son condensé est stocké : une fuite du
   * fichier ne permet pas de fabriquer un lien valide.
   */
  create(userId, ttlMinutes) {
    const token = crypto.randomBytes(32).toString("base64url");
    // Une nouvelle demande annule les précédentes.
    db.prepare("DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL").run(userId);
    db.prepare(
      "INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    ).run(
      crypto.createHash("sha256").update(token).digest("hex"),
      userId,
      now(),
      new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
    );
    return token;
  },

  /** Rend l'utilisateur si le jeton est valide, non expiré et non utilisé. */
  claim(token) {
    if (!token) return null;
    const hash = crypto.createHash("sha256").update(String(token)).digest("hex");
    const row = db
      .prepare("SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
      .get(hash, now());
    if (!row) return null;
    db.prepare("UPDATE password_resets SET used_at = ? WHERE token_hash = ?").run(now(), hash);
    return users.byId(row.user_id);
  },

  prune() {
    return db.prepare("DELETE FROM password_resets WHERE expires_at <= ?").run(now()).changes;
  },
};

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
