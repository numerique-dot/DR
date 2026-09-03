import { config } from "./config.js";

/** Journal structuré en JSON par ligne : exploitable par n'importe quel collecteur. */
function emit(level, message, fields = {}) {
  const line = { ts: new Date().toISOString(), level, message, ...fields };
  const text = config.isProduction ? JSON.stringify(line) : format(line);
  if (level === "error") console.error(text);
  else console.log(text);
}

function format({ ts, level, message, ...rest }) {
  const extra = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  return `${ts.slice(11, 19)} ${level.padEnd(5)} ${message}${extra ? " " + extra : ""}`;
}

export const log = {
  info: (message, fields) => emit("info", message, fields),
  warn: (message, fields) => emit("warn", message, fields),
  error: (message, fields) => emit("error", message, fields),
};
