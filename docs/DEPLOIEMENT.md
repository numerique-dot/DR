# Déployer D.R. RDV

Le site est une application Node 22 sans étape de build, avec une base SQLite dans un
fichier. Elle tourne dans le conteneur décrit par `Dockerfile`. Deux contraintes en découlent :

- **une seule instance** (SQLite n'est pas partagé entre machines) ;
- **un volume persistant** monté sur `/app/data`, sinon comptes et réservations disparaissent
  à chaque déploiement.

Le premier déploiement peut se faire **sans Stripe ni clé Anthropic** grâce à `PUBLIC_DEMO=true` :
la traduction répond en mode démonstration, l'abonnement est simulé, et l'interface l'affiche.
Retirez ce drapeau quand les vrais prestataires sont branchés — le serveur refusera alors de
démarrer si l'un d'eux manque.

## Variables d'environnement

| Variable | Obligatoire | Rôle |
|---|---|---|
| `NODE_ENV=production` | oui | cookies `Secure`, HSTS, garde-fous |
| `PUBLIC_URL` | oui | adresse publique en **HTTPS** (liens des courriels, vérification d'origine) |
| `TRUST_PROXY=true` | oui derrière un proxy | l'adresse IP réelle du client pour la limitation de débit |
| `DATABASE_FILE=/app/data/drdu.sqlite` | oui | sur le volume persistant |
| `PUBLIC_DEMO=true` | pour une démo | autorise l'absence de Stripe et d'Anthropic |
| `ADMIN_EMAILS` | si `MERCHANT_AUTO_APPROVE=false` | comptes autorisés à modérer |
| `ANTHROPIC_API_KEY` | hors démo | traductions réelles |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | hors démo | abonnement Membre |
| `MAIL_TRANSPORT=webhook`, `MAIL_WEBHOOK_URL` | pour envoyer des courriels | sinon ils sont seulement journalisés |
| `TIMEZONE=Europe/Paris` | non | dates dans les courriels |

La liste complète, commentée, est dans `.env.example`.

---

## Fly.io (recommandé pour commencer : région Paris, volume gratuit de 1 Go)

```bash
# 1. Outil et compte
curl -L https://fly.io/install.sh | sh
fly auth signup            # ou fly auth login

# 2. Créer l'application depuis le dépôt (ne pas déployer tout de suite)
fly launch --copy-config --no-deploy
#    → accepter le nom proposé ou en choisir un ; région : cdg (Paris)

# 3. Le volume qui portera la base
fly volumes create drdu_data --region cdg --size 1

# 4. Les secrets (adapter l'adresse au nom choisi)
fly secrets set PUBLIC_URL=https://<votre-app>.fly.dev PUBLIC_DEMO=true ADMIN_EMAILS=vous@exemple.fr

# 5. Déployer
fly deploy
fly open                   # ouvre le site dans le navigateur
```

Vérifications : `fly status` (une machine, état `started`) et `curl https://<votre-app>.fly.dev/healthz`.

Passer en réel plus tard :

```bash
fly secrets set ANTHROPIC_API_KEY=sk-ant-... STRIPE_SECRET_KEY=sk_live_... STRIPE_PRICE_ID=price_... STRIPE_WEBHOOK_SECRET=whsec_...
fly secrets unset PUBLIC_DEMO
```

---

## Render

1. Créer un compte sur render.com, puis **New → Blueprint** et pointer sur ce dépôt : Render lit
   `render.yaml`.
2. Renseigner les variables marquées `sync: false` (au minimum `PUBLIC_URL`, de la forme
   `https://<service>.onrender.com`).
3. Déployer. Le disque persistant impose le plan *Starter* (payant) ; le plan gratuit perd la
   base à chaque redémarrage.

---

## Railway

1. **New Project → Deploy from GitHub repo** : Railway détecte le `Dockerfile`.
2. Onglet **Variables** : copier celles du tableau ci-dessus (`PUBLIC_URL` est l'adresse fournie
   sous *Settings → Networking → Generate domain*).
3. Onglet **Volumes** : ajouter un volume monté sur `/app/data`.
4. Le déploiement part tout seul à chaque poussée sur `main`.

---

## Serveur dédié (VPS) avec Docker

```bash
git clone https://github.com/numerique-dot/DR.git && cd DR
cp .env.example .env && nano .env      # PUBLIC_URL, PUBLIC_DEMO=true, ADMIN_EMAILS…
docker build -t drdu .
docker run -d --name drdu --restart unless-stopped \
  -p 127.0.0.1:3000:3000 --env-file .env -v drdu-data:/app/data drdu
```

Devant, un reverse proxy TLS (Caddy est le plus simple) :

```
votre-domaine.fr {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy obtient et renouvelle le certificat Let's Encrypt automatiquement. Mettre alors
`TRUST_PROXY=true` et `PUBLIC_URL=https://votre-domaine.fr`.

---

## Après le premier déploiement

- [ ] Ouvrir `/healthz` : `status: ok`, et `billing`/`ai` en `stub`/`demo` si vous êtes en démo.
- [ ] Créer votre compte, puis un établissement de test ; vérifier qu'il paraît au catalogue.
- [ ] Si `MERCHANT_AUTO_APPROVE=false` : votre adresse doit être dans `ADMIN_EMAILS` et
      `/moderation` doit s'ouvrir.
- [ ] Sauvegarde : le fichier `/app/data/drdu.sqlite` **est** toute la donnée. Sur Fly,
      `fly volumes snapshots list` ; sur un VPS, une copie quotidienne de ce fichier suffit
      (SQLite tolère la copie à chaud en mode WAL, ou utilisez `sqlite3 .backup`).
- [ ] Remplacer les valeurs d'exemple des mentions légales (`SERVICE_*`).

## Mettre à jour

Fly : `fly deploy`. Render et Railway : poussée sur `main`. VPS : `git pull && docker build -t drdu . && docker rm -f drdu && docker run … ` (même commande qu'au premier lancement). Les migrations de base s'appliquent toutes seules au démarrage.
