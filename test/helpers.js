import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Chaque fichier de test tourne sur sa propre base, détruite à la fin. */
export function isolatedDatabase() {
  const file = path.join("data", `test-${crypto.randomBytes(4).toString("hex")}.sqlite`);
  process.env.DATABASE_FILE = file;
  process.env.NODE_ENV = "test";
  return {
    file,
    cleanup() {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          fs.unlinkSync(file + suffix);
        } catch {}
      }
    },
  };
}

/** Démarre l'application sur un port libre et rend un client HTTP minimal. */
export async function startServer() {
  const { createApp } = await import("../src/app.js");
  const server = createApp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();

  async function request(method, route, { body, headers = {}, raw = false } = {}) {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      redirect: "manual",
    });
    for (const setCookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = setCookie.split(";");
      const [name, value] = pair.split("=");
      if (value === "") jar.delete(name);
      else jar.set(name, value);
    }
    const text = await response.text();
    let data = null;
    if (!raw) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: response.status, headers: response.headers, body: raw ? text : data };
  }

  return {
    base,
    jar,
    get: (route, options) => request("GET", route, options),
    post: (route, body, options) => request("POST", route, { body, ...options }),
    del: (route, options) => request("DELETE", route, options),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export const textDocument = (text = "Amoxicilline 1 g, deux fois par jour, six jours.") => ({
  fileName: "ordonnance.txt",
  mediaType: "text/plain",
  text,
});
