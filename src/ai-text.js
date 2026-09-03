import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { LANGUAGES } from "./ai.js";

const MODEL = config.ai.model;

/**
 * Traduction des textes courts de la plateforme : consigne laissée à la
 * réservation, messages échangés entre le client et le commerçant.
 *
 * Contrairement au studio de documents, cette traduction n'est pas un produit
 * vendu par palier : sans elle, un commerçant francophone ne peut pas répondre
 * à un client sinophone. Elle est donc rendue à tout le monde.
 */
const SYSTEM = `Tu traduis les messages échangés entre un client et un professionnel sur une plateforme de réservation.

Règles :
- Tu rends UNIQUEMENT la traduction, dans la langue cible.
- Tu conserves le registre professionnel, le vouvoiement, la politesse d'usage.
- Tu conserves scrupuleusement les nombres, montants, durées, dates, heures, numéros de téléphone et références de réservation.
- Tu traduis les noms de prestations par leur équivalent courant dans la langue cible.
- Tu ne réponds jamais au message : tu le traduis.
- Tu n'ajoutes aucun commentaire ni préambule. Texte brut.`;

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

/**
 * @param {object} input
 * @param {string} input.text texte d'origine
 * @param {"zh"|"en"|"fr"} input.target langue du lecteur
 */
export async function translateShortText({ text, target }) {
  const lang = LANGUAGES[target] ?? LANGUAGES.fr;

  if (!config.ai.configured) {
    return { translation: `${DEMO_PREFIX[target] ?? DEMO_PREFIX.fr}${text}`, mode: "demo" };
  }

  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `Langue cible : ${lang.native}.\n\nTexte à traduire :\n${text}` }],
  });
  if (response.stop_reason === "refusal") {
    throw Object.assign(new Error("Texte refusé par les filtres de sécurité du modèle."), { status: 422 });
  }
  return {
    translation: response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim(),
    mode: "live",
  };
}

const DEMO_PREFIX = {
  zh: "【演示译文】",
  en: "[demo translation] ",
  fr: "[traduction de démonstration] ",
};
