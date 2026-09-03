# D.R DU — rendez-vous médical & traduction de documents de santé

Site de la clinique **D.R DU** : prise de rendez-vous, et *studio de traduction* où le
patient dépose une ordonnance, un compte rendu ou des résultats d'analyses (PDF, photo
ou texte) et récupère une traduction en **中文**, **English** ou **Français**.

Node 22, aucune dépendance de build, une seule dépendance d'exécution (`@anthropic-ai/sdk`).
Base SQLite intégrée à Node, polices auto-hébergées, image Docker fournie.

| | Essentiel (gratuit) | Membre — 9 €/mois |
|---|---|---|
| Traduction fidèle et intégrale | ✓ | ✓ |
| Commentaires, avertissements | **aucun** | — |
| Points de vigilance **注意事项** (posologie, durée, interactions, contre-indications, valeurs hors normes, échéances) | — | ✓ |
| Glossaire des termes techniques | — | ✓ |
| Questions à poser au praticien | — | ✓ |
| Plan de suivi daté | — | ✓ |
| Historique des documents (50 par compte) | — | ✓ |

**La séparation est appliquée côté serveur.** Le palier est déduit de la session, jamais
du corps de la requête : un visiteur anonyme qui envoie `{"tier":"member"}` à
`/api/translate` reçoit la traduction seule. Le palier gratuit passe par un prompt système
qui interdit tout ajout ; le palier membre passe par une sortie structurée
(`output_config.format`) dont le schéma porte les rubriques de la notice. La notice n'est
pas masquée dans l'interface, elle n'est pas générée.

Modèle : `claude-opus-5`, réflexion adaptative, repli serveur en cas de refus.

## Démarrage

```bash
npm install
npm test                  # 33 tests
npm start                 # http://localhost:3000
```

Sans `ANTHROPIC_API_KEY`, le studio répond en **mode démonstration** (notice d'exemple en
zh / en / fr) ; sans `STRIPE_SECRET_KEY`, l'abonnement est **simulé**. Les deux modes sont
signalés dans l'interface, et **refusés au démarrage en production** (voir garde-fous).

## Mise en production

```bash
cp .env.example .env      # puis renseigner les valeurs réelles
docker build -t drdu .
docker run -d --name drdu -p 3000:3000 --env-file .env -v drdu-data:/app/data drdu
```

Le volume `/app/data` porte la base SQLite : sans lui, comptes et rendez-vous disparaissent
à chaque déploiement. Derrière un proxy TLS, poser `TRUST_PROXY=true` (sinon la limitation
de débit compte toutes les requêtes sur l'IP du proxy).

### Garde-fous au démarrage

En `NODE_ENV=production`, le serveur **refuse de démarrer** si :

- `PUBLIC_URL` n'est pas en HTTPS ;
- `ANTHROPIC_API_KEY` est absente (le studio ne traduirait rien) ;
- `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` ou `STRIPE_WEBHOOK_SECRET` manquent — sinon la
  formule Membre serait accordée **sans paiement**.

`MAIL_TRANSPORT=log` ne bloque pas le démarrage mais émet un avertissement : aucun courriel
ne partirait réellement.

### Avant la première mise en ligne

- [ ] Remplacer les valeurs d'exemple des mentions légales (éditeur, SIRET, hébergeur HDS,
      numéros RPPS des praticiens) — voir `/mentions-legales` et les variables `CLINIC_*`.
- [ ] Contractualiser l'hébergement **HDS** (obligatoire pour des données de santé,
      art. L.1111-8 du code de la santé publique) et signer les actes de sous-traitance
      (Anthropic, Stripe, hébergeur).
- [ ] Configurer le webhook Stripe vers `POST /api/billing/webhook` pour les événements
      `checkout.session.completed`, `customer.subscription.{created,updated,deleted}`.
- [ ] Brancher `MAIL_WEBHOOK_URL` sur un vrai relais d'envoi, avec SPF/DKIM sur le domaine.
- [ ] Sauvegardes chiffrées de `data/drdu.sqlite` et test de restauration.
- [ ] Audit RGAA et test avec des utilisateurs de technologies d'assistance
      (la déclaration `/accessibilite` annonce honnêtement une conformité *partielle*).

## Sécurité

- **Mots de passe** dérivés par scrypt (sel aléatoire, comparaison en temps constant) ;
  10 caractères minimum. La connexion effectue une vérification même sans compte, pour ne
  pas révéler l'existence d'une adresse.
- **Sessions** en cookie `HttpOnly` / `SameSite=Lax` (+ `Secure` en production) ; seul le
  condensé SHA-256 du jeton est stocké, et une session neuve est émise à chaque connexion.
- **CSP stricte** (`default-src 'self'`, aucun script en ligne, `frame-ancestors 'none'`),
  `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS en production.
- **CSRF** : cookie `SameSite=Lax` doublé d'une vérification d'origine sur toute requête
  mutante.
- **Limitation de débit** par IP : 10 tentatives d'authentification / 15 min, 30 traductions
  et 10 réservations / heure, 300 requêtes / min au global. En mémoire — derrière plusieurs
  instances, il faut un magasin partagé (Redis).
- **Webhooks de facturation** : signature HMAC vérifiée en temps constant, horodatage rejeté
  au-delà de 5 minutes (anti-rejeu), et idempotence par identifiant d'événement.
- **Réponses d'erreur** sans détail interne ; les traces restent dans le journal.
- Les documents déposés ne sont **jamais écrits sur disque** : mémoire, appel au modèle,
  abandon.

## Design

Système de jetons CSS dans `public/styles.css` : palette clinique ivoire / vert profond,
échelle typographique fluide, rythme de 8 px, **mode sombre** natif.

- **Typographie** — Fraunces et Inter **auto-hébergées** dans `public/fonts/` : aucune
  requête vers un tiers, ce qui évite le transfert d'adresses IP à Google Fonts, contesté
  en Europe pour un site de santé. Sous-ensembles latin (416 Ko), `font-display: swap`,
  préchargement des deux fichiers du premier rendu, cache immuable d'un an.
- **Contrastes** vérifiés au calcul : toutes les paires texte/fond ≥ 4,5:1 (WCAG AA), dans
  les deux thèmes.
- **Accessibilité** — lien d'évitement en premier focus, `:focus-visible` partout, dialogues
  clavier, zones cliquables ≥ 44 px, `prefers-reduced-motion` respecté.
- **Impression** — la feuille de style n'imprime que la traduction.

## Architecture

```
src/server.js            point d'entrée : garde-fous, écoute, arrêt propre
src/app.js               routage HTTP, statiques (ETag, gzip, cache), journal des requêtes
src/config.js            configuration d'environnement et garde-fous de production
src/db.js                SQLite (node:sqlite) : migrations, requêtes préparées
src/auth.js              comptes, mots de passe scrypt, sessions par cookie
src/billing.js           Stripe Checkout et portail en REST, webhooks signés, mode simulé
src/mailer.js            courriels transactionnels (transports « log » et « webhook »)
src/security.js          en-têtes, CSP, limitation de débit, vérification d'origine
src/ai.js                appels Claude : prompts des deux paliers, schéma de la notice
src/logger.js            journal structuré en JSON par ligne
public/                  interface et pages légales (HTML/CSS/JS sans build)
test/                    suite node:test, base isolée par fichier
```

### API

| Méthode | Route | Rôle |
|---|---|---|
| `GET` | `/healthz` | sonde de vivacité (état, version, modes) |
| `GET` | `/api/config` | modes, langues, praticiens et créneaux libres, utilisateur courant |
| `POST` | `/api/auth/signup` · `/login` · `/logout` | comptes et session |
| `GET` | `/api/auth/me` | utilisateur courant |
| `POST` | `/api/billing/checkout` | ouvre le paiement de l'abonnement |
| `POST` | `/api/billing/portal` | gestion et résiliation |
| `POST` | `/api/billing/webhook` | événements Stripe (signés, idempotents) |
| `POST` | `/api/translate` | traduit un document (`target`, `fileName`, `mediaType`, `dataBase64` ou `text`) |
| `GET` | `/api/history` · `DELETE /api/history/:id` | historique du membre |
| `GET` · `POST` | `/api/appointments` | ses rendez-vous, et réservation |

Un créneau ne peut être pris deux fois : la contrainte `UNIQUE(doctor_id, slot)` sert de
verrou, deux réservations simultanées ne peuvent pas passer.

Pages publiques : `/`, `/mentions-legales`, `/confidentialite`, `/cgu`, `/accessibilite`,
`/robots.txt`, `/sitemap.xml`, plus une page 404.

## Limites connues

- **Une seule instance** : la limitation de débit est en mémoire et SQLite est local. Pour
  monter en charge, il faut un magasin partagé et une base réseau.
- **Pas de réinitialisation de mot de passe** ni de double authentification.
- Les créneaux sont déclarés en dur dans `src/doctors.js` : pas encore d'agenda praticien,
  ni d'annulation en ligne.
- Le build de l'image Docker n'a pas pu être exécuté dans l'environnement de développement
  (aucun démon Docker) ; la CI le construit à chaque poussée.
- La traduction est une aide à la compréhension : **seul le document d'origine fait foi**.
