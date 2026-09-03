# D.R DU — traduction de documents médicaux

Service de **traduction de documents médicaux**, opéré sur mandat d'un médecin : le patient
dépose une ordonnance, un compte rendu ou des résultats d'analyses (PDF, photo ou texte) et
reçoit la traduction en **中文**, **English** ou **Français**.

Ce n'est ni un établissement de santé ni un cabinet : **aucune consultation, aucune prise de
rendez-vous, aucun acte de soin.**

Node 22, aucune étape de build, une seule dépendance d'exécution (`@anthropic-ai/sdk`).
SQLite intégré à Node, polices auto-hébergées, image Docker fournie.

## Sans rétention par défaut

Le document déposé **n'est jamais écrit sur disque** : il transite en mémoire, part au modèle,
puis est abandonné. La traduction est renvoyée à l'écran et **n'est pas enregistrée non plus**.

C'est un choix d'architecture, pas un réglage cosmétique : sans donnée de santé au repos, le
service sort du champ de l'obligation d'**hébergement certifié HDS** (art. L.1111-8 du code de
la santé publique), qui porte sur l'*hébergement* de données de santé.

La fonction d'historique existe mais reste **désactivée** (`HISTORY_ENABLED=false`). Si elle est
activée, le logiciel **refuse de démarrer en production** sans `HDS_HOSTING_CERTIFIED=true`,
c'est-à-dire sans attestation d'un contrat d'hébergement certifié HDS. Et même activée, la
conservation reste un choix explicite du patient, coche par coche, à chaque traduction.

| | Essentiel (gratuit) | Membre — 9 €/mois |
|---|---|---|
| Traduction fidèle et intégrale | ✓ | ✓ |
| Commentaires, avertissements | **aucun** | — |
| Points de vigilance **注意事项** (posologie, durée, interactions, contre-indications, valeurs hors normes, échéances) | — | ✓ |
| Glossaire des termes techniques | — | ✓ |
| Questions à poser au praticien | — | ✓ |
| Plan de suivi daté | — | ✓ |
| Historique des documents | — | ✓ *si la conservation est activée* |

**La séparation est appliquée côté serveur.** Le palier est déduit de la session, jamais du
corps de la requête : un visiteur anonyme qui envoie `{"tier":"member"}` à `/api/translate`
reçoit la traduction seule. Le palier gratuit passe par un prompt système qui interdit tout
ajout ; le palier membre passe par une sortie structurée (`output_config.format`) dont le
schéma porte les rubriques de la notice. La notice n'est pas masquée dans l'interface : elle
n'est pas générée.

Modèle : `claude-opus-5`, réflexion adaptative, repli serveur en cas de refus.

## Démarrage

```bash
npm install
npm test                  # 35 tests
npm start                 # http://localhost:3000
```

Sans `ANTHROPIC_API_KEY`, le studio répond en **mode démonstration** ; sans
`STRIPE_SECRET_KEY`, l'abonnement est **simulé**. Les deux modes sont signalés dans
l'interface et refusés au démarrage en production.

## Mise en production

```bash
cp .env.example .env      # puis renseigner les valeurs réelles
docker build -t drdu .
docker run -d --name drdu -p 3000:3000 --env-file .env -v drdu-data:/app/data drdu
```

Le volume `/app/data` porte la base SQLite (comptes et abonnements — pas de données de santé
en mode sans rétention). Derrière un proxy TLS, poser `TRUST_PROXY=true`.

### Garde-fous au démarrage

En `NODE_ENV=production`, le serveur **refuse de démarrer** si :

- `PUBLIC_URL` n'est pas en HTTPS ;
- `ANTHROPIC_API_KEY` est absente ;
- Stripe n'est pas configuré (sinon la formule Membre serait accordée sans paiement) ;
- `HISTORY_ENABLED=true` sans `HDS_HOSTING_CERTIFIED=true`.

### Avant la première mise en ligne

- [ ] Remplacer les valeurs d'exemple des mentions légales : éditeur, SIRET, hébergeur, et
      **identité du médecin donneur d'ordre** (`SERVICE_*`, `MANDATING_DOCTOR`).
- [ ] Formaliser le **mandat du médecin** : périmètre du service, responsabilités, mention
      sur le site.
- [ ] Signer les actes de sous-traitance (Anthropic, Stripe, hébergeur du site).
- [ ] Configurer le webhook Stripe vers `POST /api/billing/webhook`
      (`checkout.session.completed`, `customer.subscription.{created,updated,deleted}`).
- [ ] Brancher `MAIL_WEBHOOK_URL` sur un relais réel, avec SPF/DKIM.
- [ ] N'activer `HISTORY_ENABLED` **qu'après** signature d'un contrat d'hébergement HDS.
- [ ] Audit RGAA et test avec des utilisateurs de technologies d'assistance.

## Sécurité

- **Mots de passe** dérivés par scrypt (sel aléatoire, comparaison en temps constant),
  10 caractères minimum ; la connexion vérifie un condensé même sans compte, pour ne pas
  révéler l'existence d'une adresse.
- **Sessions** en cookie `HttpOnly` / `SameSite=Lax` (+ `Secure` en production) ; seul le
  condensé SHA-256 du jeton est stocké, session neuve à chaque connexion.
- **CSP stricte** (`default-src 'self'`, aucun script en ligne, `frame-ancestors 'none'`),
  `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS en production.
- **CSRF** : `SameSite=Lax` doublé d'une vérification d'origine sur les requêtes mutantes.
- **Limitation de débit** par IP : 10 authentifications / 15 min, 30 traductions / heure,
  300 requêtes / min au global. En mémoire — un magasin partagé est nécessaire au-delà d'une
  instance.
- **Webhooks de facturation** : HMAC vérifié en temps constant, horodatage rejeté au-delà de
  5 minutes, idempotence par identifiant d'événement.
- **Réponses d'erreur** sans détail interne.

## Design

Système de jetons CSS dans `public/styles.css` : palette ivoire / vert profond, échelle
typographique fluide, rythme de 8 px, **mode sombre** natif.

- **Typographie** — Fraunces et Inter **auto-hébergées** dans `public/fonts/` : aucune requête
  vers un tiers, ce qui évite le transfert d'adresses IP à Google Fonts, contesté en Europe
  pour un service de santé. Sous-ensembles latin (416 Ko), préchargement, cache immuable.
- **Contrastes** ≥ 4,5:1 (WCAG AA) dans les deux thèmes, vérifiés au calcul.
- **Accessibilité** — lien d'évitement en premier focus, `:focus-visible` partout, dialogues
  clavier, zones cliquables ≥ 44 px, `prefers-reduced-motion` respecté.
- **Impression** — la feuille de style n'imprime que la traduction.

## Architecture

```
src/server.js            point d'entrée : garde-fous, écoute, arrêt propre
src/app.js               routage HTTP, statiques (ETag, gzip, cache), journal
src/config.js            configuration, fonctions optionnelles, garde-fous de production
src/db.js                SQLite (node:sqlite) : migrations, requêtes préparées
src/auth.js              comptes, scrypt, sessions par cookie
src/billing.js           Stripe Checkout et portail en REST, webhooks signés, mode simulé
src/mailer.js            courriels transactionnels (transports « log » et « webhook »)
src/security.js          en-têtes, CSP, limitation de débit, vérification d'origine
src/ai.js                appels Claude : prompts des deux paliers, schéma de la notice
src/logger.js            journal structuré en JSON par ligne
public/                  interface et pages légales (HTML/CSS/JS sans build)
test/                    node:test, base isolée par fichier
```

### API

| Méthode | Route | Rôle |
|---|---|---|
| `GET` | `/healthz` | sonde (état, version, modes, rétention) |
| `GET` | `/api/config` | modes, langues, état de la conservation, utilisateur courant |
| `POST` | `/api/auth/signup` · `/login` · `/logout` | comptes et session |
| `GET` | `/api/auth/me` | utilisateur courant |
| `POST` | `/api/billing/checkout` · `/portal` | souscription, gestion et résiliation |
| `POST` | `/api/billing/webhook` | événements Stripe (signés, idempotents) |
| `POST` | `/api/translate` | traduit un document (`target`, `fileName`, `mediaType`, `dataBase64` ou `text`, `save`) |
| `GET` · `DELETE` | `/api/history[/:id]` | historique du membre — **404 si la conservation est désactivée** |

Pages publiques : `/`, `/mentions-legales`, `/confidentialite`, `/cgu`, `/accessibilite`,
`/robots.txt`, `/sitemap.xml`, plus une page 404.

## Limites connues

- **Une seule instance** : limitation de débit en mémoire, SQLite local.
- **Pas de réinitialisation de mot de passe** ni de double authentification.
- Le build Docker n'a pas pu être exécuté dans l'environnement de développement (aucun démon) ;
  la CI le construit à chaque poussée.
- Les valeurs des mentions légales sont des exemples, signalés comme tels sur la page.
- La traduction est une aide à la compréhension : **seul le document d'origine fait foi**.
