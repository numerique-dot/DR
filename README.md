# D.R DU — plateforme de réservation multilingue

Plateforme de mise en relation : les **professionnels s'inscrivent**, publient leurs
prestations et leurs créneaux ; les **clients réservent** et échangent avec eux, chacun
dans sa langue. Le chinois, le français et l'anglais sont traités à égalité.

D.R DU est un **intermédiaire** : les prestations sont fournies par les professionnels
inscrits. Aucune commission n'est prélevée, aucun paiement de prestation n'est encaissé.

Node 22, aucune étape de build, une seule dépendance d'exécution (`@anthropic-ai/sdk`).
SQLite intégré à Node, police auto-hébergée, image Docker fournie.

## Ce que fait la plateforme

**Côté client** — parcourir le catalogue (filtres ville et métier), voir les prestations
avec durée et prix, réserver un créneau libre, laisser une précision **dans sa langue**,
échanger avec le professionnel, annuler à tout moment.

**Côté professionnel** — inscrire son établissement, décrire ses prestations (durée, prix,
activation), ouvrir des créneaux par plage horaire et par pas, suivre ses réservations,
répondre aux clients. Le back-office existe en **français, chinois et anglais**.

**La traduction, à trois endroits**

| Où | Qui en bénéficie | Comment |
|---|---|---|
| Précision laissée à la réservation | le professionnel la lit dans sa langue | traduite à la demande, mise en cache |
| Messages échangés | les deux, dans les deux sens | traduits par message, l'original reste consultable |
| Interface du back-office | le professionnel | dictionnaire figé (`src/i18n.js`), sans appel au modèle |
| Documents déposés (outil séparé) | le client | traduction gratuite ; formule Membre pour les points de vigilance |

Deux principes tenus partout : **l'original reste consultable et fait foi**, et une phrase
déjà traduite n'est **jamais repayée** (cache par sujet et par langue, invalidé à l'édition).

## Formules

| | Essentiel (gratuit) | Membre — 9 €/mois |
|---|---|---|
| Réservation, agenda, messages traduits | ✓ | ✓ |
| Commission sur les prestations | aucune | aucune |
| Traduction de documents | le texte, fidèlement | ✓ |
| Points de vigilance **注意事项** sur un document (montants, échéances, engagements, résiliation) | — | ✓ |
| Glossaire, questions à poser, actions de suivi | — | ✓ |

Le palier est déduit de la **session**, jamais du corps de la requête : un visiteur anonyme
qui envoie `{"tier":"member"}` à `/api/translate` reçoit la traduction seule. La notice
n'est pas masquée dans l'interface, elle n'est pas générée.

Modèle : `claude-opus-5`, réflexion adaptative, repli serveur en cas de refus. Les textes
courts passent en effort `low` : traduire un message ne demande pas la même dépense qu'un
contrat de dix pages.

## Démarrage

```bash
npm install
npm test                  # 61 tests
npm start                 # http://localhost:3000
```

Sans `ANTHROPIC_API_KEY`, les traductions répondent en **mode démonstration** ; sans
`STRIPE_SECRET_KEY`, l'abonnement est **simulé**. Les deux modes sont signalés dans
l'interface et refusés au démarrage en production.

## Pages

| Route | Rôle |
|---|---|
| `/` | présentation, deux entrées (client / professionnel) |
| `/reserver` | catalogue, réservation, « mes réservations », fils de discussion |
| `/pro` | inscription et back-office : agenda, réservations, prestations, fiche |
| `/traduction` | outil de traduction de documents |
| `/mentions-legales` `/confidentialite` `/cgu` `/accessibilite` | obligations légales |

## API

| Méthode | Route | Rôle |
|---|---|---|
| `GET` | `/healthz` | sonde (état, version, modes) |
| `GET` | `/api/config` | modes, langues, dictionnaire, catégories, utilisateur, établissement |
| `POST` | `/api/auth/signup` · `/login` · `/logout` | comptes et session |
| `PUT` | `/api/locale` | langue de l'interface |
| `GET` | `/api/catalog` | catalogue public (`?ville=`, `?categorie=`) |
| `GET` | `/api/merchants/:id` | fiche, prestations et créneaux libres |
| `POST` | `/api/merchants` | inscription d'un établissement |
| `GET` · `PUT` | `/api/merchant/me` | back-office : fiche, prestations, créneaux |
| `GET` | `/api/merchant/bookings` | réservations reçues, précisions traduites |
| `POST` · `PUT` · `DELETE` | `/api/merchant/services[/:id]` | prestations |
| `POST` · `DELETE` | `/api/merchant/slots[/:id]` | créneaux |
| `GET` · `POST` | `/api/bookings` | ses réservations, et réserver |
| `POST` | `/api/bookings/:id/cancel` | annulation (client ou professionnel) |
| `GET` · `POST` | `/api/bookings/:id/messages` | fil traduit |
| `POST` | `/api/translate` | traduction de document |
| `GET` · `DELETE` | `/api/history[/:id]` | historique — 404 si la conservation est désactivée |
| `POST` | `/api/billing/checkout` · `/portal` · `/webhook` | abonnement Membre |

## Décisions techniques notables

- **Un créneau ne peut pas être réservé deux fois** : `bookings.slot_id` porte une
  contrainte `UNIQUE`, qui sert de verrou même sous deux requêtes simultanées. Annuler
  libère le créneau, qui repart au catalogue.
- **Unicité réelle des créneaux** : en SQL, deux `NULL` ne sont pas égaux, donc une
  contrainte `UNIQUE(commerçant, instant, prestation)` laissait passer des doublons quand
  la prestation était nulle. La migration 4 pose un index d'expression
  `COALESCE(service_id, '')` — le test le vérifie.
- **La limitation de débit ne compte que les échecs d'authentification** : une connexion
  réussie remet le compteur à zéro. Plusieurs personnes derrière une même adresse IP
  (bureau, réseau mobile) n'ont pas à se pénaliser entre elles.
- **Le cache de traduction est invalidé à l'édition** d'une fiche : un texte modifié n'est
  jamais servi avec son ancienne traduction.
- **Cloisonnement** : un fil de discussion n'est lisible que par le client et le
  professionnel concernés ; le back-office n'est accessible qu'au propriétaire de la fiche.

## Mise en production

```bash
cp .env.example .env      # puis renseigner les valeurs réelles
docker build -t drdu .
docker run -d --name drdu -p 3000:3000 --env-file .env -v drdu-data:/app/data drdu
```

Le volume `/app/data` porte la base SQLite. Derrière un proxy TLS, poser `TRUST_PROXY=true`.

En `NODE_ENV=production`, le serveur **refuse de démarrer** si `PUBLIC_URL` n'est pas en
HTTPS, si `ANTHROPIC_API_KEY` manque, ou si Stripe n'est pas configuré (sinon la formule
Membre serait accordée sans paiement).

### Avant la première mise en ligne

- [ ] Renseigner les mentions légales réelles (éditeur, SIRET, hébergeur) — variables `SERVICE_*`.
- [ ] Décider du régime d'entrée des commerçants : `MERCHANT_AUTO_APPROVE=false` impose une
      validation manuelle avant publication au catalogue.
- [ ] Signer les actes de sous-traitance (Anthropic, Stripe, hébergeur).
- [ ] Configurer le webhook Stripe vers `POST /api/billing/webhook`.
- [ ] Brancher `MAIL_WEBHOOK_URL` sur un relais réel, avec SPF/DKIM.
- [ ] Audit RGAA et test avec des utilisateurs de technologies d'assistance.

## Design

Registre **administratif** : bleu de référence (#000091) pour l'action et la navigation,
**rouge** réservé au signalement, **violet** en appui et pour les liens visités, fonds
**blancs et gris clairs**. Angles droits, ombres discrètes, typographie sans empattement
(Inter, auto-hébergée : aucune requête vers un tiers).

- **Contrastes** vérifiés au calcul : toutes les paires texte/fond ≥ 4,5:1 (WCAG AA), en
  thème clair comme en thème sombre.
- **Mode sombre** natif via `prefers-color-scheme`.
- **Accessibilité** : lien d'évitement en premier focus, `:focus-visible` visible partout,
  dialogues clavier, zones cliquables ≥ 44 px, `prefers-reduced-motion` respecté.

## Architecture

```
src/server.js            point d'entrée : garde-fous, écoute, arrêt propre
src/app.js               routage HTTP, statiques (ETag, gzip, cache), journal
src/config.js            configuration, fonctions optionnelles, garde-fous de production
src/db.js                SQLite : migrations, commerçants, prestations, créneaux,
                         réservations, messages, cache de traduction
src/auth.js              comptes, scrypt, sessions par cookie
src/i18n.js              dictionnaire fr / zh / en de l'interface
src/ai-text.js           traduction des textes courts (précisions, messages)
src/ai.js                traduction de documents : deux paliers, schéma de la notice
src/billing.js           Stripe Checkout et portail, webhooks signés, mode simulé
src/mailer.js            courriels (bienvenue, confirmation, annulation, abonnement)
src/security.js          en-têtes, CSP, limitation de débit, vérification d'origine
src/logger.js            journal structuré en JSON par ligne
public/                  quatre pages + pages légales, modules ES sans build
test/                    node:test, base isolée par fichier
```

## Limites connues

- **Une seule instance** : limitation de débit en mémoire, SQLite local.
- **Pas de réinitialisation de mot de passe** ni de double authentification.
- Pas de photos d'établissement (pas de stockage d'objets), pas de notation ni d'avis.
- Les fuseaux horaires suivent celui du serveur : à traiter avant d'ouvrir hors de France.
- Le build Docker n'a pas pu être exécuté ici (aucun démon) ; la CI le construit.
- Les traductions sont produites par un modèle : **l'original fait foi**.
