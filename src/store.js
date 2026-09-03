import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.resolve(process.cwd(), "data");

/** Petite persistance fichier : une collection = un fichier JSON. */
function file(collection) {
  return path.join(DATA_DIR, `${collection}.json`);
}

export function readCollection(collection) {
  try {
    return JSON.parse(fs.readFileSync(file(collection), "utf8"));
  } catch {
    return [];
  }
}

export function writeCollection(collection, rows) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file(collection), JSON.stringify(rows, null, 2));
  return rows;
}

export function insert(collection, row) {
  const rows = readCollection(collection);
  rows.push(row);
  writeCollection(collection, rows);
  return row;
}

/* ---------- Rendez-vous ---------- */

export function listAppointments(userId = null) {
  const rows = readCollection("appointments");
  return userId ? rows.filter((row) => row.userId === userId) : rows;
}

/** Créneaux déjà pris pour un praticien. */
export function bookedSlots(doctorId) {
  return new Set(
    readCollection("appointments")
      .filter((row) => row.doctorId === doctorId)
      .map((row) => row.slot),
  );
}

export function createAppointment(input) {
  return insert("appointments", {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    reference: `DRDU-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
    ...input,
  });
}

/* ---------- Historique des traductions (membres) ---------- */

const HISTORY_LIMIT = 50;

export function listHistory(userId) {
  return readCollection("history")
    .filter((row) => row.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function saveHistory(userId, result) {
  const row = {
    id: crypto.randomUUID(),
    userId,
    createdAt: new Date().toISOString(),
    fileName: result.fileName,
    target: result.target,
    document_type: result.document_type ?? "",
    translation: result.translation ?? "",
    summary: result.summary ?? "",
    cautions: result.cautions ?? [],
    glossary: result.glossary ?? [],
    questions_for_doctor: result.questions_for_doctor ?? [],
    follow_up: result.follow_up ?? [],
  };
  const rows = readCollection("history");
  rows.push(row);
  // On borne l'historique par membre pour éviter un fichier qui gonfle sans fin.
  const mine = rows.filter((r) => r.userId === userId);
  const excess = mine.length - HISTORY_LIMIT;
  const dropped = excess > 0 ? new Set(mine.slice(0, excess).map((r) => r.id)) : new Set();
  writeCollection("history", rows.filter((r) => !dropped.has(r.id)));
  return row;
}

export function deleteHistory(userId, id) {
  const rows = readCollection("history");
  const kept = rows.filter((row) => !(row.id === id && row.userId === userId));
  if (kept.length === rows.length) return false;
  writeCollection("history", kept);
  return true;
}
