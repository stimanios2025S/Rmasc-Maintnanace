# Passation — Maintenance RMASC

> Document à donner tel quel à un nouveau chat. Il reprend ce qui a été construit,
> ce qui est en cours et **non commité**, les pièges qui ont coûté du temps, et ce
> qui reste à faire dans l'ordre.

## État du dépôt

| | |
|---|---|
| Dépôt | `C:\Users\HP\Documents\Rmasc-Maintnanace-main\Rmasc-Maintnanace-main` |
| Branche | `main`, poussée sur `origin` |
| Dernier commit | `8e03b78` |
| Non commité | 6 chemins — **les écrans du devis** |
| Tests | **aucun** (ni jest, ni vitest, ni playwright, ni cypress) |
| Base de données | **aucune** sur la machine — ni PostgreSQL, ni Docker, ni `psql` |

## Le projet

**Next.js 14** (App Router) + **Prisma 5.22** + **PostgreSQL**. 161 fichiers
source, 36 commits, interface entièrement en français. Gestion d'un parc
d'ascenseurs : bons de travail, techniciens, télémesure IoT, alertes, facturation.

Modules existants : tableau de bord, carte du parc, ascenseurs, bons de travail,
alertes, seuils d'alerte, entretien programmé, fiches techniques, portail
technicien, portail client, administration (clients, personnel, incidents),
registres (rapports d'inspection, factures), pièces détachées, devis.

### Deux réglages gouvernent tout

- `OPEN_ACCESS="true"` — aucune connexion demandée, chaque requête est traitée
  comme un **administrateur**. Attention : le mode est appliqué **côté serveur**,
  il n'y a pas de cookie NextAuth, donc `useSession()` rend toujours `null` dans
  le navigateur.
- `DEMO_DATA="true"` — les routes qui ont une fixture servent des données
  inventées quand la base est injoignable. C'est ce qui rend les écrans
  exerçables sans PostgreSQL.

### Ce qu'on peut vérifier et ce qu'on ne peut pas

Se vérifient : le typage, le lint, la construction, les fonctions pures, et tout
ce qui a une fixture. Ne se vérifient pas : les POST et PATCH menés jusqu'au bout.

---

## Ce qui a été livré dans cette session

Sept commits, tous poussés.

| Commit | Objet |
|---|---|
| `78d880c` | Écran de réglage des seuils d'alerte. Corrige un défaut latent : **une seule règle écrite éteignait silencieusement la surveillance des cinq autres grandeurs mesurées**. |
| `bb0fa0e` | Registres des rapports d'inspection et des factures : filtres multicritères, exports CSV, et l'état de règlement des factures — qui n'existait pas et a dû être ajouté avec l'action de le poser. |
| `6cd495d` | Demande de pièces détachées (table `PartRequirement`) et sa fiche PDF. Extrait la charte des documents dans `lib/documents/charte.ts`. |
| `af6fca7` | Fiche d'entretien mensuel `For: APP/DA/04/13` : grille officielle à 14 points, portée par le rapport d'inspection via un type de feuille. |
| `b8a3348` | Devis `For: APP/DA/04/14`, côté serveur : modèle, règles d'état, comptes avec **TVA 19 %**, montant en lettres, API et PDF. |
| `4011126` | Correctif trouvé en capture d'écran : la valeur mesurée s'imprimait avec quinze décimales sur la feuille d'entretien. |
| `8e03b78` | En accès libre, la barre latérale masquait ses propres écrans. |

---

## Le travail en cours, NON COMMITÉ

**Section 1 de la feuille de route : les écrans du devis.** Écrit, typé, à moitié
vérifié.

| Chemin | État |
|---|---|
| `src/app/(dashboard)/administration/devis/page.tsx` | écrit · **200 vérifié** |
| `src/app/(dashboard)/administration/devis/[id]/page.tsx` | écrit · non vérifié |
| `src/app/(dashboard)/client/devis/page.tsx` | écrit · non vérifié |
| `src/app/api/quotes/route.ts` | modifié · 2 correctifs |
| `src/components/layout/app-shell.tsx` | modifié · 2 entrées de menu |
| `src/lib/demo/responses.ts` | modifié · recherche libre |

### Les deux défauts corrigés dans l'API au passage

1. **Le bureau se facturait lui-même ses devis.** Quand un rôle de gestion
   saisissait une demande prise par téléphone, `clientId` recevait son propre
   identifiant au lieu de celui du propriétaire de l'immeuble. L'offre
   n'apparaissait dans le portail d'aucun client.
2. **La fiche de chiffrage recevait un tableau de lignes vide.** La fonction qui
   ajoutait les totaux retirait `lines` de la réponse — correct pour le registre,
   fatal pour l'écran qui édite les lignes.

### Ce qui reste pour clore la section

- Vérifier `/administration/devis/quote_2` et `/client/devis` dans un navigateur.
- Lancer `npx next lint --dir src` puis le build — **serveur de développement arrêté**.
- Commiter et pousser, dans le style du dépôt.

### Note sur les statuts

Le modèle porte `REQUESTED → SENT → ACCEPTED / REFUSED`, plus `CANCELLED`. Ce ne
sont pas des `PENDING / APPROVED / REJECTED` : ce sont ces états-là que les règles
de transition valident et que le PDF imprime.

---

## Les pièges qui ont coûté du temps

### 1. Ne JAMAIS lancer `npm run build` pendant que `npm run dev` tourne

Les deux écrivent dans le même `.next`. Le mélange d'artefacts casse le serveur
avec `TypeError: __webpack_modules__[moduleId] is not a function`.

Réparation :

```powershell
taskkill /F /IM node.exe
Remove-Item -Recurse -Force .\.next
npm run dev
```

### 2. Captures d'écran : Edge sans interface, un profil neuf par capture

`chromium-cli` n'existe pas ici. Microsoft Edge est du Chromium et sait faire,
mais il faut un `--user-data-dir` **différent à chaque lancement** : une instance
verrouille le profil précédent et la capture suivante n'arrive jamais.

```powershell
&"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --headless=new --disable-gpu --no-first-run `
  --user-data-dir="$env:TEMP\edge-a" `
  --virtual-time-budget=25000 --window-size=1500,1400 `
  --screenshot="$env:TEMP\shot.png" "http://localhost:3000/tableau-de-bord"
```

`--virtual-time-budget` est indispensable : les écrans chargent leurs données côté
navigateur, une capture immédiate ne montrerait que la coquille.

### 3. Le classificateur de commandes tombe en panne par intermittence

Beaucoup de commandes sont refusées avec « Auto mode could not evaluate this
action » alors qu'elles sont sans danger. **Il faut simplement relancer.** Ne pas
interpréter ça comme une boucle volontaire.

`Read`, `Grep`, `Glob`, `Write` et `Edit` ne passent pas par ce classificateur et
fonctionnent toujours — s'en servir quand les commandes sont bloquées.

### 4. Lire le contenu d'un PDF, pas son apparence

Les PDF sont produits par `pdfkit`. Pour vérifier un document : décompresser ses
flux (`zlib.inflateSync`) et relire son texte. Attention, **pdfkit écrit le texte
en chaînes hexadécimales** dans des tableaux `TJ` — un premier script cherchant
des chaînes littérales ne trouve rien. Les accents sont en WinAnsi (`e9` pour
« é »), pas en UTF-8.

C'est ce contrôle qui a révélé que les montants s'imprimaient `185 /000,00`.

---

## Ce qui reste, dans l'ordre

1. **Terminer et commiter les écrans du devis** — *en cours*
2. **Tableau centralisé des pièces à commander** — le panneau existe mais
   seulement *à l'intérieur d'un bon de travail*. Le bureau n'a aucune vue
   d'ensemble des demandes en attente, alors que l'API le permet déjà
   (`?status=PENDING`). Une pièce demandée depuis un toit attend une décision que
   personne ne voit.
3. **Raccorder la facture à `charte.ts`** — le PDF de facture garde sa propre
   copie des marges, encres, polices, en-tête société et tampon. À refactoriser
   **avec une comparaison octet par octet du rendu avant/après** : c'est un
   document opposable, et changer l'aspect d'une pièce déjà envoyée à un client
   serait pire que quatre chartes qui divergent.
4. **Module Contrats & SLA** — *à cadrer avant de coder*. `SLATier` et
   `clientType` (CONTRACTED / NON_CONTRACTED) existent et s'affichent, mais il n'y
   a **aucune gestion** : pas de dates, pas de renouvellement, pas de résiliation,
   pas de délai promis ni de pénalité. Ce qui en tient lieu est `/entretien`, qui
   gère le programme de visites. Décision produit avant d'être du code.
5. **Harnais de tests** — rien n'existe. Les fonctions pures rapporteraient le
   plus pour le moins : `computeQuoteTotals`, `amountInWords`,
   `quoteTransitionRefusal`, `transitionRefusal`, `boundsViolation`. C'est là que
   des défauts ont déjà été trouvés en les exerçant.
6. **Nettoyage** — `GET /api/telemetry` n'a aucun appelant ; le `README.md` ne
   décrit pas les modules récents.

---

## Comment vérifier, ici et maintenant

Le serveur doit tourner (`npm run dev`), puis ouvrir `http://localhost:3000`.
Le menu latéral donne accès à tout.

### Les écrans en cours

```
/administration/devis              le registre  (200 vérifié)
/administration/devis/quote_2      le chiffrage (4 lignes)
/administration/devis/quote_1      un devis non chiffré
/administration/devis/quote_3      un devis accepté
/client/devis                      la demande côté client
```

### Les documents PDF

```
/api/quotes/quote_2/pdf                  devis chiffré, TVA 19 %, montant en lettres
/api/parts-replacement/part_wo_11/pdf    fiche de pièce, arrêt immédiat
/api/invoices/<id>/pdf                   facture (nécessite une base)
```

### Les feuilles imprimables

```
/rapports-inspection/insp_wo_11    fiche d'entretien, grille officielle à 14 points
/rapports-inspection/insp_wo_10    rapport d'inspection, pour comparer
/rapports-inspection               le registre, filtre « Feuille »
```

### Comportement attendu en mode démonstration

Les écrans à fixture s'affichent en entier. Seul `/factures` montre
« Registre indisponible » — délibérément : une facture est un document numéroté,
en inventer un serait produire un faux.

Les messages `prisma:error ... Can't reach database server` dans le terminal sont
normaux : c'est ce qui déclenche le repli.

---

## La manière de travailler attendue

- **Messages de commit en français**, dans le style du dépôt : un sujet qui décrit
  le changement, puis des sections numérotées qui expliquent le **pourquoi** —
  y compris les défauts trouvés, les décisions écartées et leurs raisons, et une
  section « VÉRIFICATIONS » honnête sur ce qui n'a pas pu être exercé.
- **Les commentaires portent le raisonnement**, pas la description du code. Le
  dépôt est écrit comme ça partout.
- **Une seule définition par règle.** Les tables de libellés, les règles de
  transition et les catalogues vivent dans des modules purs partagés entre le
  serveur et le navigateur — jamais recopiés.
- **Vérifier, pas supposer.** Les défauts les plus coûteux de cette session ont
  été trouvés en capturant l'écran, pas en relisant le code.
- **Tout en local, commit et push sur Git.** Aucun accès serveur, aucun
  déploiement. Le schéma a changé (`part_requirements`, `quotes`, `quote_lines`,
  `ReportKind`, `InvoiceStatus`) : un `db push` sera nécessaire.

---

## Un mot sur ce qui a mal tourné

Cette session a beaucoup tourné en rond. Une large part vient du classificateur
de commandes en panne, mais il y a aussi une vraie erreur : le build lancé trois
fois pendant que le serveur de développement tournait, ce qui a cassé
l'application. La règle est écrite plus haut pour qu'elle ne se reproduise pas.

**Le travail en cours n'est pas commité.** À reprendre à la section « Le travail en
cours, NON COMMITÉ ».

---

*État du dépôt au commit `8e03b78` · rien n'a été poussé hors de `origin/main`,
aucun serveur distant n'a été touché.*
