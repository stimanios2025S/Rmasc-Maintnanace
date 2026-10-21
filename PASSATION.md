# Passation — Maintenance RMASC

> Document à donner tel quel à un nouveau chat. Il décrit l'état **réel** du
> dépôt et de la production au dernier commit, ce qui reste à faire, les pièges
> qui ont coûté du temps, et ce qui n'a pas pu être vérifié.

*Dernière mise à jour : après la livraison Contrats & SLA (Livraisons 1 à 6),
QR d'embarquement client et reprise d'appareils tiers. Voir `git log -1` pour le
commit exact.*

## État du dépôt

| | |
|---|---|
| Dépôt | `C:\Users\HP\Documents\Rmasc-Maintnanace-main\Rmasc-Maintnanace-main` |
| Branche | `main`, synchronisée avec `origin/main` |
| Dernier commit local | `git log -1` — voir la ligne du haut |
| Build déployé en production | **`9ed71d9`** — l'écran magasinier (aucune des livraisons ci-dessous n'est déployée) |
| Tests | harnais de règles pures `npm run contracts:check` (179 cas) ; **aucun runner** (ni jest, ni vitest, ni playwright, ni cypress) |
| Base de données locale | **aucune** (ni PostgreSQL, ni Docker, ni `psql`) |
| Migrations Prisma | **aucune** — le projet vit par `db push` |

Depuis `9ed71d9`, **tout ce qui suit est local et non déployé** : le PDF de
facture raccordé à la charte, les contrats & SLA, le QR d'embarquement et la
reprise d'appareils tiers. Le serveur de production n'a reçu aucun de ces
commits, et **aucune commande base de données n'a été exécutée** pour eux : le
schéma local n'est même pas poussé.

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

## Ce que les sessions récentes ont livré

| Commit | Objet |
|---|---|
| `6175086` | Navigation : cinq groupes repliables au lieu de dix-neuf entrées |
| `769f59c` | QR : embarquement client, reprise d'appareils tiers, QR sur les fiches |
| `4cfbfa3` | Contrats & SLA : registre, fiche, formulaire de création |
| `4d796a1` | Contrats : reconduction tacite matérialisée et alertes d'échéance |
| `6c171ae` | Contrats : badge dynamique et portail client |
| ce commit | Harnais de règles pures (179 cas), documentation, URL locales |

Les livraisons antérieures restent valables :

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

## Les trois modules livrés depuis

### 1. Embarquement client par QR

- **`/scan/[elevatorId]`** est publique. Elle affiche l'état de l'appareil
  (code, marque/modèle, statut, immeuble, dernière visite) et un bouton
  « Demander un accès client » qui ouvre un formulaire léger (prénom, nom,
  téléphone, e-mail, rôle : Syndic / Promoteur / Propriétaire).
- Le POST public est `POST /api/access-requests` : il écrit une ligne `PENDING`
  et **n'ouvre rien**. Un doublon (même appareil, même adresse, encore en
  attente) est refusé.
- Le bureau lit la file dans **`/administration/clients/demandes`**.
  « Approuver & créer le compte » crée un `BUILDING_OWNER` avec mot de passe
  engendré, rattache l'immeuble scanné **si personne ne le possède déjà**, écrit
  la décision et prépare l'invitation.
- L'invitation part sur WhatsApp via Evolution si `EVOLUTION_*` est configuré.
  Il n'existe **aucun transport SMTP** : le courriel est un lien `mailto:`
  préparé, pas un envoi. Le compte existe dans tous les cas.
- Le QR est généré par `src/lib/documents/qr.ts`, écrit dans le dépôt (pur
  TypeScript + `node:zlib`) pour fonctionner hors ligne. Il est imprimé sur le
  devis (`APP/DA/04/14`) et la fiche d'entretien (`APP/DA/04/13`).
- Middleware : `/scan/:path*` et `POST /api/access-requests` sont publics ;
  `GET /api/access-requests` et l'approbation restent ADMIN.

### 2. Reprise d'appareils tiers

- **`/administration/ascenseurs`** enregistre un appareil qui n'est pas encore
  du parc. Le champ `originBrand` garde le constructeur d'origine (Otis, KONE,
  Schindler…), que l'énumération fermée `ElevatorBrand` ne sait pas dire.
- `POST /api/elevators` avec `takeover: true` crée automatiquement un bon
  `INSPECTION` « état des lieux », ouvert. Une erreur de création du bon ne
  défait pas la fiche — elle est signalée.
- `POST /api/elevators/[id]/takeover` valide la reprise : matricule
  `ASC-AAAA-NNNN` (suite annuelle, réessai sur collision) et QR. Refusé tant
  qu'un bon d'inspection est ouvert, avec son numéro dans le message.

### 3. Contrats & SLA

- Modèle : `Contract`, `ContractBuilding` (sélection du parc du client),
  `ContractRevision`. L'état **stocké** n'est pas l'état réel :
  `effectiveStatus` et `effectiveEndsAt` sont calculés à la lecture
  (reconduction tacite comprise). Toutes les règles pures sont dans
  `src/lib/contracts/status.ts`, lues par la route **et** les écrans.
- **`/administration/contrats`** : registre filtrable (statut calculé, palier,
  client), recherche par référence/client, badges d'échéance 60/30 j et mention
  de reconduction tacite, onglet **Décision requise**. Création d'un brouillon
  (client, immeubles filtrés sur son parc, dates, palier, reconduction, montant).
- **`/administration/contrats/[id]`** : statut calculé, date de fin effective,
  palier et délais, renouvellement, immeubles, journal des révisions. Les actions
  (activer, reprendre, renouveler, suspendre, résilier) ne sont offertes que si
  `transitionRefusal` les autorise ; un renouvellement exige une date
  postérieure, une résiliation un motif.
- **`GET /api/contracts/coverage`** : lecture dédiée aux badges et au portail
  client — palier, délais, dates, immeubles, **sans montant ni coordonnées**.
  Un `BUILDING_OWNER` est cloisonné sur son `clientId` lu dans la session.
- Badge `ContractSlaBadge` sur `/ascenseurs`, `/ascenseurs/[id]` et la barre de
  `/rapports-inspection/[id]` (masqué à l'impression). Le portail client
  `/client` affiche **Mes contrats & SLA** pour les comptes contractualisés.
- Batch : `scripts/contracts-rollover.ts` et
  `POST /api/cron/contracts-rollover` partagent `runContractsRollover`.
  Reconduction tacite matérialisée avec révision `TACIT_RENEWAL` (idempotence
  par compare-and-swap), notifications 60/30 j dédoublonnées par terme et palier,
  résumé WhatsApp optionnel. La route accepte `CONTRACTS_CRON_TOKEN` (temps
  constant) ou une session de gestion ; `?dryRun=1` n'écrit rien.
- Harnais : `npm run contracts:check` exécute **179 cas** (matrice complète des
  25 transitions, dates, reconductions, alertes, file de décision, journal,
  sélection de couverture). Il sort en erreur au premier écart. Ce n'est **pas**
  un runner de tests.
- Limites connues : le batch n'est pas planifié ; les seuils sont les constantes
  60/30, pas le `noticeDays` du contrat ; la création depuis l'UI exige ADMIN
  (la liste des clients est ADMIN-only).

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
2. **Runner de tests.** Le harnais `contracts:check` couvre les règles pures des
   contrats (179 cas) mais rien d'autre n'est exécuté automatiquement. Les
   fonctions pures qui rapporteraient le plus : `computeQuoteTotals`,
   `amountInWords`, `quoteTransitionRefusal`, `boundsViolation`,
   `transmissionRefusal`, `buildStockSignature`, `stockPriorityFor`. Aucune CI
   n'existe.
3. **Durcissement production** : téléphone d'escalade, Evolution/WhatsApp,
   jeton IoT, sauvegarde planifiée.
4. **Exercer réellement la liaison au magasin central** (voir ci-dessus).
5. **Planifier le batch contrats.** Le code existe
   (`npm run contracts:rollover`, `POST /api/cron/contracts-rollover`) mais rien
   ne l'appelle. Poser un cron ou un appel HTTP avec `CONTRACTS_CRON_TOKEN`, et
   vérifier d'abord par `--dry-run` / `?dryRun=1`.
6. **Décider du seuil d'alerte par contrat.** Les alertes utilisent les
   constantes 60/30 jours, pas le `noticeDays` du contrat ; la cadrage prévoyait
   ce dernier. Changer la règle touche `expiryAlert`, les fiches et les tests.
7. **Adopter `prisma migrate`** avant la prochaine évolution de schéma.
8. **`GET /api/telemetry`** : le supprimer ou l'exposer.
9. **README / PASSATION** — à tenir à jour à chaque module. Les deux décrivent
   désormais le QR, les reprises et les contrats.

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
npm.cmd run contracts:check
npm.cmd run build
```

Sans base de données, `npm.cmd run dev` ouvre l'application en administrateur
(`OPEN_ACCESS="true"`) — **la page de connexion est un cul-de-sac** : le provider
credentials interroge PostgreSQL, absent. Les écrans qui lisent des données
réelles (contrats, demandes d'accès, reprises) répondront alors 503 ou vide :
c'est attendu, pas une régression du code.

### Les adresses locales, par rubrique

Base : `http://localhost:3000` (le port de production est 3010, le `.env` local
utilise 3000). Les `<id>` s'obtiennent en cliquant une ligne depuis le registre
correspondant ; `<elevatorId>` depuis `/ascenseurs` ou depuis le QR imprimé.

#### Accès

| Adresse | Ce qu'on y vérifie |
|---|---|
| `http://localhost:3000/` | Redirige vers le tableau de bord |
| `http://localhost:3000/connexion` | Page de connexion (cul-de-sac sans base, voir ci-dessus) |

#### Supervision

| Adresse | Ce qu'on y vérifie |
|---|---|
| `http://localhost:3000/tableau-de-bord` | KPI du parc, santé, liste d'attention, alertes |
| `http://localhost:3000/carte` | Carte géolocalisée, cinq niveaux d'attention |
| `http://localhost:3000/alertes` | File de triage, acquittement et résolution en masse |
| `http://localhost:3000/seuils` | Règles d'alerte par métrique |
| `http://localhost:3000/ascenseurs` | Parc et **badge SLA dynamique** par appareil |
| `http://localhost:3000/ascenseurs/<id>` | Fiche appareil et **badge SLA** dans l'en-tête |
| `http://localhost:3000/fiches-techniques` | Fiches techniques du parc |

#### Interventions

| Adresse | Ce qu'on y vérifie |
|---|---|
| `http://localhost:3000/bons-de-travail` | Registre des bons, dispatch |
| `http://localhost:3000/bons-de-travail/<id>` | Détail, révisions, validation de fin d'intervention |
| `http://localhost:3000/entretien` | Programme préventif, échéances, planification |
| `http://localhost:3000/rapports-inspection` | Registre des inspections |
| `http://localhost:3000/rapports-inspection/<id>` | Fiche `APP/DA/04/13` ; **badge SLA** dans la barre, absent à l'impression |
| `http://localhost:3000/technicien` | Portail terrain : file, pointage géolocalisé, rapport, signature |
| `http://localhost:3000/administration/incidents` | Incidents signalés par les clients, escalade |

#### Administration

| Adresse | Ce qu'on y vérifie |
|---|---|
| `http://localhost:3000/administration/contrats` | Registre des contrats, filtres, badges 60/30 j, onglet **Décision requise** |
| `http://localhost:3000/administration/contrats/<id>` | Fiche contrat : statut calculé, date effective, palier, délais, immeubles, journal des révisions |
| `http://localhost:3000/administration/ascenseurs` | **Reprise d'appareils tiers**, bon d'état des lieux, matricule `ASC-AAAA-NNNN` + QR |
| `http://localhost:3000/administration/clients` | Comptes clients et immeubles |
| `http://localhost:3000/administration/clients/<id>` | Fiche client, parc rattaché, accès générés |
| `http://localhost:3000/administration/clients/demandes` | **Demandes d'accès QR** : approuver, créer le compte, invitation |
| `http://localhost:3000/administration/devis` | Registre des devis |
| `http://localhost:3000/administration/devis/<id>` | Édition des lignes, TVA 19 %, PDF `APP/DA/04/14` |
| `http://localhost:3000/administration/personnel` | Comptes du personnel et identifiants |
| `http://localhost:3000/administration/pieces` | Demandes de pièces : valider → commander → poser |
| `http://localhost:3000/administration/magasinier` | Réception magasin (module non modifié) |
| `http://localhost:3000/factures` | Factures figées, état de règlement, PDF |

#### Portail Client

| Adresse | Ce qu'on y vérifie |
|---|---|
| `http://localhost:3000/client` | Portail contractuel : **Mes contrats & SLA**, urgences, incidents, factures |
| `http://localhost:3000/client/devis` | Devis du client |
| `http://localhost:3000/client/fiche-technique` | Fiche technique du prospect |

#### Scan QR

| Adresse | Ce qu'on y vérifie |
|---|---|
| `http://localhost:3000/scan/<elevatorId>` | Page **publique** : état de l'appareil et formulaire de demande d'accès (`PENDING`) |

Le traitement bureau de ces demandes se fait dans
`http://localhost:3000/administration/clients/demandes` (rubrique Administration).

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
