import { config, assertProductionReady } from "./config.js";
import { log } from "./logger.js";
import { createApp, startHousekeeping } from "./app.js";

for (const warning of assertProductionReady()) log.warn(warning);

const server = createApp();
startHousekeeping();

server.listen(config.port, config.host, () => {
  log.info("D.R RDV en écoute", {
    url: config.publicUrl,
    env: config.env,
    ia: config.ai.configured ? "API Claude" : "démonstration",
    facturation: config.billing.provider,
    courriel: config.mail.transport,
  });
});

/* Arrêt propre : on cesse d'accepter, on laisse finir les requêtes en cours. */
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    log.info("arrêt demandé, fermeture des connexions", { signal });
    server.close(() => {
      log.info("arrêt terminé");
      process.exit(0);
    });
    // Filet de sécurité si une connexion traîne.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

process.on("unhandledRejection", (reason) => log.error("promesse rejetée non traitée", { reason: String(reason) }));
process.on("uncaughtException", (error) => {
  log.error("exception non interceptée", { error: error.message, stack: error.stack });
  process.exit(1);
});
