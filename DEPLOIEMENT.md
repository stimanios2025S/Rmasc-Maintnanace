# Déploiement — Rmasc Maintenance (ElevatorPulse)

Procédure de mise en production sur le serveur **greendutyconfig**.

Ce document décrit une installation **isolée**. L'application reçoit son propre
dossier, sa propre base de données, son propre port et son propre sous-domaine.
Elle ne partage rien avec les applications déjà en place et ne les modifie en
aucune façon.

---

## 1. Décisions actées

| Sujet | Choix retenu |
|---|---|
| Processus permanent | **pm2** (`ecosystem.config.js` fourni) |
| Base de données | **PostgreSQL existant**, avec une base dédiée `elevator_pulse` |
| Dossier serveur | **`~/rmasc-maintenance`** |
| Port applicatif | **3010** — à confirmer libre (étape 0) |
| Code source | Dépôt GitHub, cloné sur le serveur |

Applications existantes à ne jamais toucher : `admedco`, `admedco-app`,
`rmasc-erp`, `rmasc-dashboard`, `apps/`, `backups/`, et la configuration
Cloudflare (`cloudflared`, `tunnel-url.txt`).

---

## 2. Prérequis sur le serveur

À vérifier avant de commencer :

```bash
node -v          # 18.17 minimum, 20 LTS recommandé
npm -v
git --version
pm2 -v           # si absent : sudo npm install -g pm2
```

Si Node est trop ancien, l'installer avec `nvm` plutôt qu'avec le gestionnaire
de paquets système — cela évite de casser les autres applications qui
dépendent de la version actuelle.

---

## 3. Étape 0 — Reconnaître l'existant (lecture seule)

Ces commandes **ne modifient rien**. Elles servent à connaître l'existant avant
d'écrire quoi que ce soit.

```bash
# Quels conteneurs tournent, et sur quels ports ?
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'

# Qui écoute déjà sur le port 5432 (PostgreSQL) ?
ss -tlnp | grep :5432

# Le port 3010 est-il libre ?
ss -tlnp | grep :3010 || echo "3010 LIBRE"

# Toutes les applications qui écoutent, pour choisir un port sans collision
ss -tlnp | grep LISTEN
```

**Ce qu'on cherche :** savoir si PostgreSQL tourne déjà (et sous quelle forme :
service système ou conteneur Docker). Cela détermine les commandes de l'étape 1.

---

## 4. Étape 1 — Créer la base dédiée

> **Ne pas lancer `docker compose up`.** Le `docker-compose.yml` du projet
> démarre son propre PostgreSQL et réclame le port 5432, qui est très
> probablement déjà occupé par ton instance existante. On réutilise
> l'installation présente, avec une base et un utilisateur dédiés.

### Cas A — PostgreSQL installé comme service système

```bash
sudo -u postgres psql <<'SQL'
CREATE USER rmasc_maint WITH PASSWORD 'REMPLACER_PAR_UN_MOT_DE_PASSE_FORT';
CREATE DATABASE elevator_pulse OWNER rmasc_maint;
GRANT ALL PRIVILEGES ON DATABASE elevator_pulse TO rmasc_maint;
SQL
```

### Cas B — PostgreSQL dans un conteneur Docker

```bash
# Remplacer <conteneur> par le nom vu à l'étape 0
docker exec -i <conteneur> psql -U postgres <<'SQL'
CREATE USER rmasc_maint WITH PASSWORD 'REMPLACER_PAR_UN_MOT_DE_PASSE_FORT';
CREATE DATABASE elevator_pulse OWNER rmasc_maint;
GRANT ALL PRIVILEGES ON DATABASE elevator_pulse TO rmasc_maint;
SQL
```

### Vérifier

```bash
psql "postgresql://rmasc_maint:MOT_DE_PASSE@127.0.0.1:5432/elevator_pulse" -c "SELECT 1;"
```

La base `elevator_pulse` est **entièrement séparée** des bases des autres
applications. Aucune commande de cette procédure ne les lit ni ne les écrit.

---

## 5. Étape 2 — Récupérer le code

```bash
cd ~
git clone https://github.com/<TON_COMPTE>/rmasc-maintenance.git
cd rmasc-maintenance
```

Le dossier `~/rmasc-maintenance` n'existe pas encore : il est créé par le
`git clone`. Aucun autre dossier n'est touché.

---

## 6. Étape 3 — Configurer `.env`

Le fichier `.env` n'est **jamais** dans le dépôt (il est dans `.gitignore`). Il
est créé à la main sur le serveur, une seule fois.

```bash
cp .env.example .env
nano .env
```

Contenu attendu :

```env
DATABASE_URL="postgresql://rmasc_maint:MOT_DE_PASSE@127.0.0.1:5432/elevator_pulse?schema=public"

# Générer avec : openssl rand -base64 32
NEXTAUTH_SECRET="..."

# L'adresse publique réelle, sinon les redirections de connexion cassent
NEXTAUTH_URL="https://maintenance.<ton-domaine>"

# Protège l'endpoint d'ingestion IoT. Générer avec : openssl rand -hex 32
IOT_INGEST_TOKEN="..."

# IMPÉRATIF en production : pas de session synthétique, pas de fausses données
OPEN_ACCESS="false"
DEMO_DATA="false"
```

Générer les deux secrets :

```bash
openssl rand -base64 32   # → NEXTAUTH_SECRET
openssl rand -hex 32      # → IOT_INGEST_TOKEN
```

> **L'application refuse de démarrer en production** si `NEXTAUTH_SECRET` ou
> `NEXTAUTH_URL` manquent. C'est volontaire : un déploiement qui démarre avec
> une clé de signature publique est pire qu'un déploiement qui ne démarre pas.
>
> `OPEN_ACCESS=true` et `DEMO_DATA=true` sont ignorés si `NODE_ENV=production`.
> Les laisser à `false` reste la bonne pratique : aucune ambiguïté possible.

Protéger le fichier :

```bash
chmod 600 .env
```

---

## 7. Étape 4 — Installer, migrer, peupler

```bash
npm ci                      # installation exacte depuis package-lock.json
npx prisma generate         # types Prisma
npx prisma db push          # crée les tables dans elevator_pulse
npx prisma db seed          # données de démonstration + comptes
```

Le `db seed` affiche à la fin la liste des comptes créés, avec le statut de
dispatch des techniciens. Il est **idempotent** : le relancer ne duplique rien.

> **Le seed crée des comptes de démonstration avec le mot de passe
> `password123`.** Sur un serveur exposé publiquement, changer ces mots de passe
> immédiatement après la première connexion, ou ne pas lancer `db seed` du tout
> et créer les comptes réels à la main. Voir la section 12.

---

## 8. Étape 5 — Construire et lancer

```bash
npm run build               # doit se terminer sans erreur
pm2 start ecosystem.config.js
pm2 save                    # mémorise la liste des processus
pm2 startup                 # affiche une commande à copier-coller, pour le boot
```

Vérifier :

```bash
pm2 status
pm2 logs rmasc-maintenance --lines 50
curl -I http://127.0.0.1:3010
```

L'application doit répondre sur `http://127.0.0.1:3010` **avant** d'être exposée
sur Internet.

---

## 9. Étape 6 — Exposer via Cloudflare Tunnel

Le serveur utilise déjà `cloudflared`. **Ne pas réinstaller ni reconfigurer le
service existant** : il suffit d'ajouter une entrée.

Ajouter dans la configuration du tunnel (généralement
`~/.cloudflared/config.yml` ou `/etc/cloudflared/config.yml`) :

```yaml
  - hostname: maintenance.<ton-domaine>
    service: http://localhost:3010
```

Puis :

```bash
sudo systemctl restart cloudflared     # ou : pm2 restart cloudflared, selon l'installation
```

> **Point de vigilance.** Ce fichier de configuration contient les routes de
> *toutes* tes applications. Une indentation incorrecte coupe l'accès à
> l'ensemble. Sauvegarder avant modification :
> `cp ~/.cloudflared/config.yml ~/.cloudflared/config.yml.bak`

---

## 10. Mises à jour

Après chaque modification poussée sur GitHub :

```bash
cd ~/rmasc-maintenance
git pull
npm ci                      # si package-lock.json a changé
npx prisma generate
npx prisma db push          # uniquement si prisma/schema.prisma a changé
npm run build
pm2 reload rmasc-maintenance
```

`pm2 reload` redémarre sans couper le service. En cas de problème, revenir en
arrière :

```bash
git log --oneline -5
git checkout <commit_precedent>
npm ci && npx prisma generate && npm run build
pm2 reload rmasc-maintenance
```

---

## 11. Sauvegardes

```bash
mkdir -p ~/backups
pg_dump -U rmasc_maint -h 127.0.0.1 elevator_pulse \
  | gzip > ~/backups/elevator_pulse_$(date +%F_%H%M).sql.gz
```

Un dump **avant** chaque `prisma db push` qui modifie le schéma. Le dossier
`~/backups` existe déjà sur le serveur : y déposer l'archive, sans toucher aux
sauvegardes des autres applications.

---

## 12. Après la mise en ligne

- [ ] Se connecter et **changer le mot de passe de chaque compte** issu du seed
- [ ] Vérifier que `/api/health` répond `{"status":"ok","checks":{"database":true}}`
- [ ] Créer les comptes réels (administrateur, manager, techniciens)
- [ ] Vérifier que le dialogue de dispatch n'affiche que les techniciens disponibles
- [ ] Confirmer qu'aucune autre application n'a été affectée

---

## 13. Dépannage

| Symptôme | Cause probable |
|---|---|
| `P1001: Can't reach database server` | PostgreSQL arrêté, mauvais port, ou `DATABASE_URL` erroné |
| `Invalid environment configuration: NEXTAUTH_SECRET is required` | `.env` incomplet — normal en production |
| `502` ou page blanche derrière le tunnel | L'application ne tourne pas : `pm2 logs rmasc-maintenance` |
| `EADDRINUSE` au démarrage | Le port 3010 est occupé : en choisir un autre dans `ecosystem.config.js` **et** dans la config du tunnel |
| Connexion impossible, redirection vers `localhost` | `NEXTAUTH_URL` ne correspond pas à l'adresse publique |
| Le port 5432 est déjà pris par le projet | `docker-compose.yml` a été lancé par erreur : `docker compose down` |

---

## 14. Ce que cette procédure ne fait pas

- Elle ne lance **pas** le `docker-compose.yml` du projet (PostgreSQL et Redis
  dédiés). Redis n'est utilisé par aucun code de l'application.
- Elle ne met en place **aucun test automatisé ni CI** : il n'y en a pas dans le
  projet à ce jour.
- Elle ne configure **aucune politique CSP**, ni sauvegarde planifiée
  automatique. Les commandes de sauvegarde sont fournies, la planification
  (`cron`) reste à décider.
- Elle ne couvre **pas** le service Python de référence
  (`src/lib/ai/python/`), qui n'est appelé par aucun code de l'application.
