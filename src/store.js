import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.resolve(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "appointments.json");

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}

export function listAppointments() {
  return readAll();
}

export function createAppointment(input) {
  const appointment = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    reference: `DRDU-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
    ...input,
  };
  const all = readAll();
  all.push(appointment);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
  return appointment;
}
