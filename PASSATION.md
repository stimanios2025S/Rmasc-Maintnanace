# Passation — Maintenance RMASC

> Document à donner tel quel à un nouveau chat. Il décrit l'état **réel** du
> dépôt et de la production au dernier commit, ce qui reste à faire, les pièges
> qui ont coûté du temps, et ce qui n'a pas pu être vérifié.

*Dernière mise à jour : commit `11f2b6d`.*

## État du dépôt

| | |
|---|---|
| Dépôt | `C:\Users\HP\Documents\Rmasc-Maintnanace-main\Rmasc-Maintnanace-main` |
| Branche | `main`, synchronisée avec `origin/main` |
| Dernier commit local | `11f2b6d` — cadrage Contrats & SLA |
| Build déployé en production | **`9ed71d9`** — l'écran magasinier |
| Tests | **aucun** (ni jest, ni vitest, ni playwright, ni cypress) |
| Base de données locale | **aucune** (ni PostgreSQL, ni Docker, ni `psql`) |
| Migrations Prisma | **aucune** — le projet vit par `db push` |

`da99ff7` (raccordement du PDF de facture à la charte) et `11f2b6d` (cadrage)
sont **locaux, non déployés**.

### Deux commandes gouvernent tout

- `OPEN_ACCESS="true"` — aucune connexion demandée, chaque requête est traitée
  comme un **administrateur**, côté serveur. `useSession()` rend toujours `null`
  dans le navigateur. **Ignoré si `NODE_ENV=production`.**
- `DEMO_DATA="true"` — les routes qui ont une fixture servent des données
  inventées quand la base est injoignable. **Ignoré si `NODE_ENV=production`.**

Les deux gardes sont écrites dans `src/lib/auth/open-access.ts:76` et
`src/lib/demo/mode.ts:37`, et elles fonctionnent : la production les force à
`false`.

---

## Ce que cette session a livré

| Commit | Objet |
|---|---|
| `cad2a13` | Registre centralisé des pièces (`/administration/pieces`) |
| `768986c` | **Sécurité** : la page de connexion ne distribue plus un accès administrateur |
| `01608bb` | Outil de rotation des mots de passe compromis |
| `9ed71d9` | Poste du chef de service technique (`/administration/magasinier`) + transmission au magasin central |
| `da99ff7` | PDF de facture raccordé à `charte.ts`, sortie prouvée identique |
| `11f2b6d` | Cadrage Contrats & SLA (document, aucun code) |

### L'incident de sécurité, à connaître

`/connexion` rendait un panneau « Accès démo rapide » dont les quatre boutons
appelaient `signIn("credentials")` avec `password123` écrit en clair sous les
boutons. Publié sur une URL ouverte, il donnait un accès administrateur à
quiconque chargeait la page. Il n'y avait **aucune** garde d'environnement.

Correctifs appliqués :

1. Panneau conditionné à `process.env.NODE_ENV !== "production"`, évalué à la
   construction — les identifiants sont **absents du JavaScript livré**.
2. Rotation des six comptes qui utilisaient encore `password123`.
3. `scripts/rotate-demo-passwords.ts` pour recommencer si besoin.

**Reste ouvert :** `scripts/diagnose-auth.ts --fix` remet `password123` sur les
comptes de démonstration. C'est probablement l'origine de l'état constaté.
Ce script n'est **pas** gardé. Ne le lancez pas en production.

---

## État de la production

| | |
|---|---|
| Serveur | `sarlrmasc@100.73.62.52` (Tailscale), Ubuntu 24.04 |
| Application | `rmasc-maintenance`, PM2 id 3, port **3010** |
| URL publique | `https://maintenance.sarl-rmasc.com` |
| Build déployé | `9ed71d9` |
| Base | PostgreSQL `elevator_pulse` sur `127.0.0.1:5432` |
| Sauvegarde | `~/db-backups/backup.sql` — **ponctuelle, non planifiée** |

**Cinq autres applications tournent sur la même machine** et ne doivent pas être
touchées : `erpmes` (3100), `rmasc-onsite` (4002), `rmasc-web` (3200),
`wa-gateway` (3000), `admedco:4003` (4003). Le port **3000 est pris** ;
`rmasc-maintenance` utilise 3010.

Règles absolues :

- **Jamais** `pm2 restart all`, `pm2 delete all`, `pkill node`, `killall node`.
- Cibler uniquement `pm2 restart rmasc-maintenance`.
- **Sauvegarder la base** avant tout `db push`.

La machine a **redémarré le 2026-10-13 à 13:47** ; les six applications sont
revenues seules (PM2 configuré). Les correctifs de sécurité ont survécu.

Réglages d'exploitation encore absents : `ADMIN_PHONE_NUMBER` (alertes SMS
désactivées), `EVOLUTION_*` (notifications WhatsApp inertes),
`IOT_INGEST_TOKEN` à vérifier (écritures de télémétrie non authentifiées s'il
est vide).

---

## Le magasin central : contrat connu, échange jamais exercé

La seconde application RMASC vit dans `/opt/rmasc-stock` sur le même serveur.
Elle **n'est pas démarrée** (absente de `pm2 list`).

Interface partenaire, déjà construite côté stock :

```
GET  /api/v1/external            index public
GET  /api/v1/external/stock      HMAC — disponibilité
POST /api/v1/external/demandes   HMAC — dépôt d'une demande → statut SOUMISE
POST /api/v1/external/retours    HMAC — bons de retour
```

Authentification par trois en-têtes, signature HMAC-SHA256 sur
`<horodatage>\n<MÉTHODE>\n<chemin>\n<corps brut>` :

```
x-rmasc-key        EXTERNAL_API_KEY
x-rmasc-timestamp  secondes Unix (tolérance 300 s)
x-rmasc-signature  hex
```

Côté maintenance, `src/lib/stock/client.ts` signe, `src/lib/stock/eligibility.ts`
porte les règles pures, et `/api/parts-replacement/transmit` transmet. Une
transmission réussie fait passer la demande à `ORDERED` et enregistre la
référence du magasin.

**Limite majeure : aucun échange réel n'a eu lieu.** La signature est vérifiée
contre le contrat *écrit* et le code de la route, jamais contre le vérificateur
du magasin. Un en-tête mal nommé ou un chemin différent ne se verrait qu'au
premier envoi.

Pour l'activer : démarrer l'application stock, puis poser dans le `.env` de la
maintenance `STOCK_API_URL` (en `127.0.0.1:<port>`, jamais par le domaine
public), `STOCK_API_KEY` et `STOCK_API_SECRET` (les `EXTERNAL_API_*` du stock).

---

## Ce qui reste, dans l'ordre

1. **Neutraliser `diagnose-auth.ts --fix` en production.** Petit, urgent.
   Protège la rotation des mots de passe.
2. **Harnais de tests.** Rien n'existe. Les fonctions pures rapporteraient le
   plus : `computeQuoteTotals`, `amountInWords`, `quoteTransitionRefusal`,
   `transitionRefusal`, `boundsViolation`, `transmissionRefusal`,
   `buildStockSignature`, `stockPriorityFor`.
3. **Durcissement production** : téléphone d'escalade, Evolution/WhatsApp,
   jeton IoT, sauvegarde planifiée.
4. **Exercer réellement la liaison au magasin central** (voir ci-dessus).
5. **Contrats & SLA** — `CONTRATS-SLA-CADRAGE.md`. Le modèle, la machine à
   états et les écrans y sont proposés ; **cinq décisions produit** attendent une
   validation avant le code (barème SLA, granularité, renouvellement par défaut,
   périmètre des pénalités, emplacement de `SLATier`).
6. **Adopter `prisma migrate`** avant la prochaine évolution de schéma.
7. **`GET /api/telemetry`** : le supprimer ou l'exposer.
8. **README** — mis à jour au commit `11f2b6d` avec les modules livrés. À tenir
   à jour à chaque module.

---

## Les pièges qui coûtent du temps

### 1. `npm` en PowerShell

`npm` appelle `npm.ps1`, bloqué par la stratégie d'exécution. **Utiliser
`npm.cmd`** — aucun réglage système à changer. `npx.cmd` de même.
Et se placer dans le **dossier imbriqué**, celui qui contient `package.json`.

### 2. Ne JAMAIS lancer `build` pendant que `dev` tourne

Les deux écrivent dans `.next`. Réparation : `taskkill /F /IM node.exe`,
supprimer `.next`, relancer.

### 3. `npm ci` saute les scripts Prisma

npm 11 applique `allowScripts` et **n'exécute pas** les `postinstall` de
`@prisma/client` ni de `@prisma/engines`. Après un `npm ci` sur un serveur,
toujours lancer `npx prisma generate` explicitement — sinon l'application démarre
sans client ni moteur de requête.

### 4. Le classificateur de commandes tombe par intermittence

Beaucoup de commandes sont refusées avec « Auto mode could not evaluate this
action » alors qu'elles sont sans danger. **Relancer.** `Read`, `Grep`, `Glob`,
`Write` et `Edit` ne passent pas par ce classificateur.

### 5. « Octet par octet » est impossible sur un PDF

pdfkit inscrit la date de création : deux rendus du même code diffèrent. Comparer
les **flux de contenu décompressés** — c'est ce que fait
`scripts/pdf-golden.ts`, et c'est ce qui décide de l'apparence.

### 6. `pg_dump` refuse `?schema=public`

Retirer la query string de `DATABASE_URL` avant de dumper, sinon le fichier
produit est vide et l'erreur ne mentionne pas la cause.

---

## Comment vérifier, ici et maintenant

```powershell
cd C:\Users\HP\Documents\Rmasc-Maintnanace-main\Rmasc-Maintnanace-main
npm.cmd run typecheck
npx.cmd next lint --dir src
npm.cmd run build
```

Sans base de données, `npm.cmd run dev` ouvre l'application en administrateur
(`OPEN_ACCESS="true"`) — **la page de connexion est un cul-de-sac** : le provider
credentials interroge PostgreSQL, absent.

Comptes de démonstration d'un seed frais (`prisma/seed.ts`) : mot de passe
commun `password123`, comptes `admin@`, `manager@`, `tech1@`, `tech2@`,
`tech3@elevatorpulse.com`, `owner@metroplaza.com`, `prospect@elbahia.dz`.
**En production, ces mots de passe ont été révoqués.**

---

## La manière de travailler attendue

- **Messages de commit en français**, dans le style du dépôt : un sujet qui
  décrit le changement, puis des sections numérotées qui expliquent le
  **pourquoi** — y compris les défauts trouvés, les décisions écartées et une
  section « VÉRIFICATIONS » honnête sur ce qui n'a pas pu être exercé.
- **Les commentaires portent le raisonnement**, pas la description du code.
- **Une seule définition par règle.** Les tables de libellés, les règles de
  transition et les catalogues vivent dans des modules purs partagés — jamais
  recopiés.
- **Vérifier, pas supposer.** Les défauts les plus coûteux ont été trouvés en
  exerçant le code, pas en le relisant.
