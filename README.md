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
| Historique des documents | — | ✓ |
| Points de vigilance **注意事项** (posologie, durée, interactions, contre-indications, valeurs hors normes, échéances) | — | ✓ |
| Glossaire des termes techniques | — | ✓ |
| Questions à poser au praticien | — | ✓ |
| Plan de suivi daté | — | ✓ |

La séparation est appliquée côté serveur : le palier Essentiel utilise un prompt
système qui interdit tout ajout au texte traduit ; le palier Membre passe par une
sortie structurée (`output_config.format`) dont le schéma porte les rubriques de la
notice. Le client ne peut pas « débloquer » la notice, elle n'est jamais générée.

## Comptes membres

Un compte est créé depuis « Devenir membre » (courriel, mot de passe de 8 caractères
minimum). Les mots de passe sont dérivés par **scrypt** avec sel aléatoire ; la session
tient dans un cookie `HttpOnly` / `SameSite=Lax` dont seul le condensé SHA-256 est
stocké côté serveur, avec une durée de vie de 30 jours.

**Le palier est déterminé par la session, jamais par la requête** : un visiteur anonyme
qui envoie `{"tier":"member"}` à `/api/translate` reçoit la traduction seule. La notice
n'est simplement pas générée.

Il n'y a pas encore de paiement : la formule Membre est accordée à l'inscription.
C'est le seul point à brancher sur un prestataire (`createUser` dans `src/auth.js`).

## Historique des documents

Chaque traduction membre est enregistrée (50 documents par compte, les plus anciens
sont évincés) et consultable dans « Mes documents traduits » : traduction, résumé,
points de vigilance et plan de suivi, avec suppression unitaire. Un membre ne voit
et ne supprime que ses propres documents.

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
src/auth.js              comptes, mots de passe scrypt, sessions par cookie
src/doctors.js           praticiens, langues parlées, tarifs, créneaux
src/store.js             persistance fichier : rendez-vous, comptes, sessions, historique
public/                  interface (HTML/CSS/JS sans build)
```

### API

| Méthode | Route | Rôle |
|---|---|---|
| `GET` | `/api/config` | mode IA, langues, praticiens |
| `POST` | `/api/auth/signup` | crée un compte et ouvre une session |
| `POST` | `/api/auth/login` | ouvre une session |
| `POST` | `/api/auth/logout` | ferme la session |
| `GET` | `/api/auth/me` | utilisateur courant |
| `GET` | `/api/history` | historique du membre (401 sans session, 403 hors formule Membre) |
| `DELETE` | `/api/history/:id` | supprime un document de son propre historique |
| `GET` | `/api/appointments` | ses propres rendez-vous (session requise) |
| `POST` | `/api/appointments` | crée un rendez-vous (`doctorId`, `slot`, `patientName`, `email`, …) |
| `POST` | `/api/translate` | traduit un document (`tier`, `target`, `fileName`, `mediaType`, `dataBase64` ou `text`) |

Le document est envoyé en base64 dans le corps JSON (bloc `document` pour un PDF,
`image` pour une photo, texte brut sinon) — 9 Mo maximum. Les fichiers ne sont pas
écrits sur le disque : ils transitent en mémoire jusqu'à l'appel du modèle.

Modèle : `claude-opus-5`, réflexion adaptative, repli serveur en cas de refus.

## Limites assumées

- Pas de paiement : l'inscription accorde directement la formule Membre.
- Persistance en fichiers JSON sous `data/` — suffisant pour une démonstration, à
  remplacer par une base de données avant toute mise en production (les écritures
  ne sont pas transactionnelles).
- Les créneaux sont déclarés en dur dans `src/doctors.js` ; ils disparaissent une fois
  réservés, mais aucun courriel n'est réellement envoyé.
- La traduction est une aide à la compréhension, pas un avis médical.
