# D.R DU — rendez-vous médical & traduction de documents de santé

Site de prise de rendez-vous pour la clinique **D.R DU**, doublé d'un *studio de
traduction* : le patient dépose une ordonnance, un compte rendu ou des résultats
d'analyses (PDF, photo ou texte) et récupère une traduction en **中文**, **English**
ou **Français**.

Deux paliers, volontairement distincts :

| | Essentiel (gratuit) | Membre |
|---|---|---|
| Traduction fidèle et intégrale | ✓ | ✓ |
| Commentaires, avertissements | **aucun** | — |
| Points de vigilance **注意事项** (posologie, durée, interactions, contre-indications, valeurs hors normes, échéances) | — | ✓ |
| Glossaire des termes techniques | — | ✓ |
| Questions à poser au praticien | — | ✓ |
| Plan de suivi daté | — | ✓ |

La séparation est appliquée côté serveur : le palier Essentiel utilise un prompt
système qui interdit tout ajout au texte traduit ; le palier Membre passe par une
sortie structurée (`output_config.format`) dont le schéma porte les rubriques de la
notice. Le client ne peut pas « débloquer » la notice, elle n'est jamais générée.

## Démarrage

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # optionnel
npm start                             # http://localhost:3000
```

Sans clé API, le site démarre en **mode démonstration** : une notice d'exemple
(ordonnance amoxicilline / ibuprofène, en zh / en / fr) est renvoyée, ce qui permet
de parcourir toute l'interface hors ligne. Le bandeau du studio indique le mode actif.

## Architecture

```
src/server.js            serveur HTTP (node:http), fichiers statiques + API JSON
src/ai.js                appels Claude : prompts des deux paliers, schéma de la notice
src/demo-translation.json jeu de démonstration hors ligne
src/doctors.js           praticiens, langues parlées, tarifs, créneaux
src/store.js             persistance des rendez-vous (data/appointments.json)
public/                  interface (HTML/CSS/JS sans build)
```

### API

| Méthode | Route | Rôle |
|---|---|---|
| `GET` | `/api/config` | mode IA, langues, praticiens |
| `GET` | `/api/appointments` | rendez-vous enregistrés |
| `POST` | `/api/appointments` | crée un rendez-vous (`doctorId`, `slot`, `patientName`, `email`, …) |
| `POST` | `/api/translate` | traduit un document (`tier`, `target`, `fileName`, `mediaType`, `dataBase64` ou `text`) |

Le document est envoyé en base64 dans le corps JSON (bloc `document` pour un PDF,
`image` pour une photo, texte brut sinon) — 9 Mo maximum. Les fichiers ne sont pas
écrits sur le disque : ils transitent en mémoire jusqu'à l'appel du modèle.

Modèle : `claude-opus-5`, réflexion adaptative, repli serveur en cas de refus.

## Limites assumées

- L'authentification des membres est simulée par le sélecteur de formule : il n'y a
  pas encore de comptes, de paiement, ni d'historique persistant côté patient.
- Les créneaux sont statiques (`src/doctors.js`) et ne sont pas décrémentés après
  réservation ; aucun courriel n'est réellement envoyé.
- La traduction est une aide à la compréhension, pas un avis médical.
