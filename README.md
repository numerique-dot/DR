# D.R RDV — plateforme de réservation multilingue

Plateforme de mise en relation : les **professionnels s'inscrivent**, publient leurs
prestations et leurs créneaux ; les **clients réservent** et échangent avec eux, chacun
dans sa langue. Le chinois, le français et l'anglais sont traités à égalité.

D.R RDV est un **intermédiaire** : les prestations sont fournies par les professionnels
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
npm test                  # 90 tests
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
| `/moderation` | file de validation des fiches (comptes de `ADMIN_EMAILS`) |
| `/reinitialiser` | choix d'un nouveau mot de passe depuis le lien reçu |
| `/mentions-legales` `/confidentialite` `/cgu` `/accessibilite` | obligations légales |

## API

| Méthode | Route | Rôle |
|---|---|---|
| `GET` | `/healthz` | sonde (état, version, modes) |
| `GET` | `/api/config` | modes, langues, dictionnaire, catégories, utilisateur, établissement |
| `POST` | `/api/auth/signup` · `/login` · `/logout` | comptes et session |
| `POST` | `/api/auth/forgot` · `/reset` | réinitialisation du mot de passe |
| `GET` · `PUT` | `/api/admin/merchants[/:id]` | file de validation et décisions |
| `PUT` | `/api/merchant/visibility` | mise en pause ou remise en ligne de sa fiche |
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

## Validation des fiches

`MERCHANT_AUTO_APPROVE=true` (défaut) publie une fiche dès son dépôt. À `false`, elle part
en file d'attente et n'apparaît pas au catalogue tant qu'un modérateur ne l'a pas publiée —
le serveur refuse alors de démarrer si `ADMIN_EMAILS` est vide, faute de quoi aucune fiche
ne pourrait jamais paraître.

Le statut d'une fiche suit quatre états : **en attente**, **publiée**, **en pause** (le
commerçant l'a retirée lui-même), **refusée**. Un refus **exige un motif** : le professionnel
doit savoir quoi corriger, et il le lit dans son back-office comme dans le courriel reçu.
Une fiche refusée puis modifiée **repasse automatiquement en validation**.

Le rôle de modérateur n'est pas stocké en base : il découle de `ADMIN_EMAILS`. Une écriture
malencontreuse ne peut donc promouvoir personne, et retirer un modérateur revient à changer
une variable puis redémarrer.

## Mot de passe oublié

Demande depuis le dialogue de connexion : la réponse est **la même que l'adresse existe ou
non**, et aucun courriel ne part vers une adresse inconnue. Le lien vaut une heure
(`PASSWORD_RESET_MINUTES`), ne sert **qu'une fois**, et une nouvelle demande annule la
précédente. Seul le condensé du jeton est stocké : une fuite du fichier ne permet pas de
fabriquer un lien valide.

Au changement, **toutes les sessions ouvertes sont fermées** — si quelqu'un d'autre était
connecté, il ne l'est plus — et un courriel signale la modification. Un mot de passe refusé
(trop court) ne consomme pas le lien : l'utilisateur peut réessayer.

## Décisions techniques notables

- **Un créneau ne peut pas être réservé deux fois** : un index unique **partiel** sur
  `bookings(slot_id) WHERE status = 'confirmed'` sert de verrou même sous deux requêtes
  simultanées — et, parce qu'il ne porte que sur les réservations en cours, une annulation
  libère réellement le créneau. (Une contrainte `UNIQUE` pleine l'aurait bloqué à jamais :
  c'est un défaut relevé en revue, couvert par un test de régression.)
- **Une prestation qui a servi ne se supprime pas**, elle se désactive : l'historique des
  clients reste intact. La règle vaut côté application (409 explicite) et côté base
  (`ON DELETE RESTRICT`).
- **Une fiche hors catalogue ne reçoit pas de réservation**, même avec un identifiant de
  créneau connu : en attente, en pause, suspendue ou refusée, la réservation est refusée.
- **La suspension par la modération est distincte de la pause** : un commerçant remet en
  ligne une fiche qu'il a lui-même mise en pause, jamais une fiche suspendue.
- **Une traduction qui échoue n'emporte pas le reste** : dans un fil ou une liste de
  réservations, l'élément intraduisible est rendu avec son original et sans traduction ;
  les autres passent.
- **Unicité réelle des créneaux** : en SQL, deux `NULL` ne sont pas égaux, donc une
  contrainte `UNIQUE(commerçant, instant, prestation)` laissait passer des doublons quand
  la prestation était nulle. La migration 4 pose un index d'expression
  `COALESCE(service_id, '')` — le test le vérifie.
- **La limitation de débit ne compte que les échecs d'authentification** : une connexion
  réussie remet le compteur à zéro — mais pas une inscription, qui sinon offrirait un moyen
  gratuit de réarmer la force brute. Plusieurs personnes derrière une même adresse IP
  (bureau, réseau mobile) n'ont pas à se pénaliser entre elles.
- **Le courriel de réinitialisation part sans retarder la réponse** : un temps de réponse
  différent selon que l'adresse existe trahirait les comptes, malgré des corps identiques.
- **Les dates des courriels sont rendues dans le fuseau du service** (`TIMEZONE`,
  `Europe/Paris` par défaut) : le serveur, lui, tourne en UTC.
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
- **Pas de double authentification**, ni de changement de mot de passe depuis un compte
  connecté (seule la procédure « mot de passe oublié » existe).
- Pas de photos d'établissement (pas de stockage d'objets), pas de notation ni d'avis.
- Un seul fuseau pour les courriels (`TIMEZONE`) ; l'interface suit celui du navigateur.
  Des commerçants dans plusieurs fuseaux demanderaient un fuseau par établissement.
- Le build Docker n'a pas pu être exécuté ici (aucun démon) ; la CI le construit.
- Les traductions sont produites par un modèle : **l'original fait foi**.
