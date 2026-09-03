import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5";

/** Langues cibles proposées par l'interface. */
export const LANGUAGES = {
  zh: { label: "中文 (simplifié)", native: "chinois simplifié" },
  en: { label: "English", native: "anglais" },
  fr: { label: "Français", native: "français" },
};

/** Schéma de la réponse « membre » : traduction + notice et points de vigilance. */
const MEMBER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "document_type",
    "translation",
    "summary",
    "cautions",
    "glossary",
    "questions_for_doctor",
    "follow_up",
  ],
  properties: {
    document_type: {
      type: "string",
      description:
        "Nature du document dans la langue cible : ordonnance, compte rendu, résultat de laboratoire, courrier, devis, etc.",
    },
    translation: {
      type: "string",
      description:
        "Traduction fidèle et intégrale du document, dans la langue cible, sans ajout ni commentaire.",
    },
    summary: {
      type: "string",
      description: "Résumé en 3 à 5 phrases, dans la langue cible.",
    },
    cautions: {
      type: "array",
      description:
        "Points de vigilance (注意事项) : posologie, interactions, contre-indications, valeurs hors normes, délais à respecter.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "detail"],
        properties: {
          severity: { type: "string", enum: ["info", "attention", "urgent"] },
          title: { type: "string" },
          detail: { type: "string" },
        },
      },
    },
    glossary: {
      type: "array",
      description: "Termes médicaux expliqués en langage courant.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target", "explanation"],
        properties: {
          source: { type: "string" },
          target: { type: "string" },
          explanation: { type: "string" },
        },
      },
    },
    questions_for_doctor: {
      type: "array",
      description: "Questions à poser au praticien lors du prochain rendez-vous.",
      items: { type: "string" },
    },
    follow_up: {
      type: "array",
      description: "Actions de suivi datées ou conditionnelles (examens, renouvellement, surveillance).",
      items: { type: "string" },
    },
  },
};

const FREE_SYSTEM = `Tu es traducteur assermenté de documents médicaux pour la clinique D.R DU.

Règles absolues :
- Tu produis UNIQUEMENT la traduction fidèle et intégrale du document fourni.
- Tu conserves la structure d'origine : titres, sections, tableaux (en texte), listes, dates, unités, posologies, valeurs de laboratoire et leurs bornes de référence.
- Tu ne transformes pas les unités et tu ne corriges pas le document.
- Tu n'ajoutes AUCUN commentaire, AUCUN résumé, AUCUNE explication, AUCUN point de vigilance, AUCUN conseil médical, AUCUN avertissement.
- Si un passage est illisible, tu écris [illisible] à sa place, sans autre commentaire.
- Tu réponds en texte brut, sans balise de code ni préambule.`;

const MEMBER_SYSTEM = `Tu es traducteur médical et pharmacien conseil pour la clinique D.R DU, au service d'un patient membre.

Tu rends la traduction fidèle et intégrale du document, puis tu l'éclaires :
- « cautions » (注意事项) : posologie et durée de traitement, prises à jeun ou non, interactions et associations à éviter, contre-indications, effets indésirables à surveiller, valeurs de laboratoire hors normes, délais et échéances à ne pas manquer. Sévérité « urgent » réservée aux situations exigeant un contact médical rapide.
- « glossary » : les termes techniques expliqués simplement.
- « questions_for_doctor » et « follow_up » : concrets et actionnables.

Contraintes : tu restes strictement dans le contenu du document, tu ne poses aucun diagnostic et tu n'inventes aucune valeur. Toute la réponse est rédigée dans la langue cible demandée, sauf les termes source du glossaire. Si le document ne permet pas de remplir une rubrique, renvoie une liste vide.`;

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

export function aiConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Construit le bloc de contenu adapté au type de fichier téléversé. */
function documentBlocks({ mediaType, dataBase64, text, fileName }) {
  if (text) {
    return [{ type: "text", text: `Document « ${fileName} » :\n\n${text}` }];
  }
  if (mediaType === "application/pdf") {
    return [
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: dataBase64 },
      },
    ];
  }
  if (mediaType && mediaType.startsWith("image/")) {
    return [
      { type: "image", source: { type: "base64", media_type: mediaType, data: dataBase64 } },
    ];
  }
  // Repli : fichier texte encodé en base64.
  return [
    {
      type: "text",
      text: `Document « ${fileName} » :\n\n${Buffer.from(dataBase64, "base64").toString("utf8")}`,
    },
  ];
}

/**
 * Traduit un document téléversé.
 * @param {object} input
 * @param {"free"|"member"} input.tier palier de l'utilisateur
 * @param {"zh"|"en"|"fr"} input.target langue cible
 */
export async function translateDocument({ tier, target, fileName, mediaType, dataBase64, text }) {
  const lang = LANGUAGES[target] ?? LANGUAGES.zh;
  const blocks = documentBlocks({ mediaType, dataBase64, text, fileName });

  if (!aiConfigured()) {
    return { ...mockResult({ tier, target, fileName }), mode: "demo" };
  }

  const common = {
    model: MODEL,
    thinking: { type: "adaptive" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  };

  if (tier === "member") {
    const response = await getClient().beta.messages.create({
      ...common,
      max_tokens: 16000,
      system: [{ type: "text", text: MEMBER_SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config: { format: { type: "json_schema", schema: MEMBER_SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            ...blocks,
            {
              type: "text",
              text: `Langue cible : ${lang.native}. Traduis ce document, puis renseigne la notice complète (résumé, points de vigilance, glossaire, questions et suivi).`,
            },
          ],
        },
      ],
    });
    if (response.stop_reason === "refusal") {
      throw new Error("Document refusé par les filtres de sécurité du modèle.");
    }
    return { tier, target, fileName, mode: "live", ...extractJson(response) };
  }

  const response = await getClient().beta.messages.create({
    ...common,
    max_tokens: 16000,
    system: [{ type: "text", text: FREE_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [
          ...blocks,
          { type: "text", text: `Langue cible : ${lang.native}. Traduction seule.` },
        ],
      },
    ],
  });
  if (response.stop_reason === "refusal") {
    throw new Error("Document refusé par les filtres de sécurité du modèle.");
  }
  return {
    tier,
    target,
    fileName,
    mode: "live",
    translation: textOf(response),
    cautions: [],
    glossary: [],
    questions_for_doctor: [],
    follow_up: [],
  };
}

function textOf(response) {
  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function extractJson(response) {
  if (response.parsed_output) return response.parsed_output;
  return JSON.parse(textOf(response));
}

/** Réponse de démonstration quand aucune clé API n'est configurée. */
function mockResult({ tier, target, fileName }) {
  const demo = JSON.parse(
    fs.readFileSync(new URL("./demo-translation.json", import.meta.url), "utf8"),
  );
  const payload = demo[target] ?? demo.zh;
  const base = { tier, target, fileName, document_type: payload.document_type, translation: payload.translation };
  if (tier === "member") return { ...base, ...payload.member };
  return { ...base, summary: "", cautions: [], glossary: [], questions_for_doctor: [], follow_up: [] };
}
