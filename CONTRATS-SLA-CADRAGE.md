# Contrats & SLA — cadrage avant développement

> État : **proposition, rien n'est codé.** Ce document existe parce que la
> décision produit doit précéder le code — un contrat est un engagement opposable,
> et une règle inventée ici s'imprime un jour sur un document signé.

---

## 1. Ce qui existe aujourd'hui, et ce que cela veut dire

| Élément | Où | Ce qu'il porte réellement |
|---|---|---|
| `ClientType` | `User` (compte `BUILDING_OWNER`) | `CONTRACTED` / `NON_CONTRACTED`. Sépare deux portails, pas deux contrats. |
| `SLATier` | `Building` | `BASIC` / `STANDARD` / `PREMIUM` / `ENTERPRISE`. **Affiché** (`contract-badge.tsx`), jamais interprété. |
| `MaintenanceSchedule` | par `Elevator` | Le programme de visites : fréquence, prochaine échéance, checklist. C'est un **plan de travail**, pas un contrat. |

**Conclusion :** il n'existe aucune notion de contrat. Pas de date de début ni de
fin, pas de renouvellement, pas de résiliation, pas de délai promis, pas de
pénalité. `SLATier` est une étiquette colorée sur une fiche.

Ce qui en tient lieu est `/entretien`, qui planifie des visites — utile, mais
sans engagement contractuel.

---

## 2. Le modèle proposé

Un seul nouveau modèle, `Contract`, et un historique de ses changements.

```
Contract
  id, reference            CT-2026-0001, unique
  clientId  → User         le titulaire (BUILDING_OWNER)
  slaTier   → SLATier      le palier ENGAGÉ par ce contrat
  status                   DRAFT | ACTIVE | SUSPENDED | TERMINATED | EXPIRED
  startDate, endDate
  renewalMode              AUTO | MANUAL | NONE
  noticeDays               préavis de résiliation / non-renouvellement
  billingCycle             MONTHLY | QUARTERLY | ANNUALLY
  amount, currency         montant de l'abonnement
  responseHours            délai de prise en charge promis
  interventionHours        délai d'intervention promis
  terminatedAt, terminationReason, terminatedById
  signedAt, notes
  createdAt, updatedAt
```

Relations :

- `Contract` ↔ `Building` : **un contrat couvre N immeubles**, un immeuble n'est
  couvert que par **un contrat actif à la fois**. C'est la règle qui empêche
  deux engagements contradictoires sur le même site.
- `Contract` → `ContractRevision` : chaque changement de date, de palier ou de
  statut écrit une ligne. Même raison que `WorkOrderRevision` : six mois plus
  tard, « qui a résilié, et quand ? » n'a de réponse que si l'événement a été
  écrit au moment où il s'est produit.

**`Building.slaTier` devient une valeur de repli**, utilisée quand l'immeuble
n'est couvert par aucun contrat (client sans contrat). On ne la supprime pas :
la retirer obligerait à une migration de données et casserait l'affichage des
immeubles non contractés. La règle de lecture est unique : *le palier effectif
est celui du contrat actif, sinon celui de l'immeuble.*

---

## 3. Les règles de gestion

### 3.1 Machine à états

```
DRAFT ──signer──> ACTIVE ──suspendre──> SUSPENDED ──reprendre──> ACTIVE
                    │                        │
                    ├──résilier──> TERMINATED <┘
                    └──échéance──> EXPIRED
```

- `TERMINATED` et `EXPIRED` sont terminaux pour la période ; un renouvellement
  crée une **nouvelle** période (même contrat, nouvelles dates) plutôt que de
  ressusciter l'ancienne.
- Une seule règle bloquante, comme pour les pièces : **on ne signe pas un
  contrat dont la date de fin précède la date de début**, et **on ne résilie pas
  un contrat déjà terminé**.
- La règle vit dans un module pur `lib/contracts/status.ts`, consommé par la
  route **et** par l'écran — jamais recopiée.

### 3.2 Renouvellement

| Mode | Comportement |
|---|---|
| `AUTO` | À l'échéance, la date de fin est repoussée d'une période. Aucune action humaine. |
| `MANUAL` | Le contrat passe `EXPIRED` à l'échéance ; un écran le signale `noticeDays` avant. |
| `NONE` | Idem, mais aucune alerte : le contrat s'arrête, c'est tout. |

L'alerte « arrive à échéance » se calcule **à la lecture** à partir de
`endDate - noticeDays` ; elle n'est pas stockée. Un compteur stocké se
désynchronise à la première correction de date.

### 3.3 Résiliation

`terminatedAt` + `terminationReason` sont obligatoires ensemble. À la
résiliation, les immeubles couverts redeviennent « sans contrat » — ce qui, pour
le portail client, se traduit immédiatement par l'écran `NON_CONTRACTED`. C'est
voulu : un portail qui continuerait d'afficher « sous contrat » après une
résiliation promettrait un service qui n'existe plus.

### 3.4 SLA : ce que le palier promet

C'est **la décision qui n'appartient pas au code**. Proposition de barème, à
valider ou remplacer :

| Palier | Prise en charge | Intervention sur site |
|---|---|---|
| `BASIC` | 48 h | 5 jours ouvrés |
| `STANDARD` | 24 h | 72 h |
| `PREMIUM` | 8 h | 48 h |
| `ENTERPRISE` | 4 h | 24 h |

Ces valeurs seraient **stockées sur le contrat** (pas codées en dur), avec le
barème du palier comme valeur par défaut à la création. Un contrat négocié peut
donc promettre mieux que son palier sans qu'on invente un cinquième palier.

**Pénalités : visibilité seulement en v1.** Calculer une pénalité, c'est
calculer une somme due — donc une pièce comptable avec ses règles légales. La
v1 affiche les dépassements (« 3 interventions hors délai ce trimestre ») sans
les chiffrer. On ajoutera le montant quand la règle contractuelle sera écrite.

---

## 4. Les écrans

| Écran | Route | Contenu |
|---|---|---|
| Registre | `/administration/contrats` | Filtres : actifs, à échéance, expirés, résiliés. Colonnes : client, palier, dates, immeubles, alerte d'échéance. |
| Fiche | `/administration/contrats/[id]` | Dates, palier, engagements SLA, immeubles couverts, historique des révisions, actions (renouveler, suspendre, résilier). |
| Création | `/administration/contrats/nouveau` | Client, palier, dates, immeubles, mode de renouvellement, engagement. |
| Portail client | `/client` (encart) | Le client voit son contrat : dates, palier, engagements. Rien de plus. |

Plus : une entrée de menu, et le badge `contract-badge.tsx` alimenté par le
contrat actif plutôt que par l'étiquette de l'immeuble.

---

## 5. Décisions à valider avant d'écrire le modèle

1. **Le barème SLA** ci-dessus (3.4) — ou vos valeurs réelles ?
2. **Un contrat par client couvrant N immeubles**, ou un contrat par immeuble ?
   *Recommandation : par client.*
3. **Renouvellement `AUTO` par défaut**, ou `MANUAL` ?
   *Recommandation : `AUTO` avec préavis de 60 jours — un contrat qui expire par
   oubli est un client perdu.*
4. **Pénalités en visibilité seule en v1** ?
   *Recommandation : oui.*
5. **`SLATier` déplacé du `Building` vers le `Contract`**, le bâtiment gardant un
   repli ? *Recommandation : oui.*

---

## 6. Découpage proposé, une fois les décisions prises

| # | Livraison | Vérifiable |
|---|---|---|
| 1 | Modèle Prisma + `lib/contracts/status.ts` (règle pure) | `db push`, typecheck, cas de transition |
| 2 | API : liste, fiche, création, révision d'état | refus et cas nominaux |
| 3 | Registre + fiche (écrans) | build, rendu |
| 4 | Renouvellement automatique + alertes d'échéance | calcul à la lecture |
| 5 | Badge et portail client | build |
| 6 | Harnais de tests sur la règle pure | cas de transition |

Rien de tout cela ne touche le serveur : ce sont des commits locaux, et le
`db push` n'aura lieu qu'au déploiement, avec sauvegarde.
