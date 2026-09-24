# 🛗 ElevatorPulse — Predictive & Preventive Maintenance Platform

> Maintenance platform for elevator service companies: IoT telemetry ingestion
> with threshold alerting, statistical remaining-useful-life scoring, work order
> management with auto-dispatch, and a field technician portal.

![Next.js](https://img.shields.io/badge/Next.js-14+-black?style=flat&logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?style=flat&logo=typescript)
![Prisma](https://img.shields.io/badge/Prisma-5.14-2D3748?style=flat&logo=prisma)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-3.4-38BDF8?style=flat&logo=tailwindcss)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat&logo=postgresql)

---

## 📋 Table of Contents

- [Architecture Overview](#architecture-overview)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Quick Start](#quick-start)
- [Running Without a Database (UI preview)](#running-without-a-database-ui-preview)
- [API Reference](#api-reference)
- [IoT Simulator](#iot-simulator)
- [Predictive Engine](#predictive-engine)
- [Database Schema](#database-schema)
- [Roles & Access](#roles--access)
- [Known Gaps](#known-gaps)

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Frontend (Next.js 14)                       │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌────────────────┐  │
│  │Dashboard │  │Elevators │  │Work Orders│  │Field Technician│  │
│  │ + KPIs   │  │ + RUL    │  │ + Kanban  │  │ + Checklist    │  │
│  └──────────┘  └──────────┘  └───────────┘  └────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                     Route Handlers (REST, /api/*)                 │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────────┐   │
│  │  Telemetry   │  │  Work Orders  │  │  Predictive Engine   │   │
│  │  Ingestion   │  │  + Dispatch   │  │  RUL + Risk Scores   │   │
│  └──────┬───────┘  └───────┬───────┘  └──────────┬───────────┘   │
├─────────┼──────────────────┼─────────────────────┼───────────────┤
│         └──────────────────┼─────────────────────┘               │
│                    PostgreSQL + Prisma ORM                        │
├──────────────────────────────────────────────────────────────────┤
│  ┌──────────────────┐  ┌──────────────────────────────────────┐  │
│  │  IoT Simulator   │  │  Python FastAPI reference service    │  │
│  │  npm run sim     │  │  (standalone, not wired into the app)│  │
│  └──────────────────┘  └──────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

**How data flows:** IoT devices (or the bundled simulator) `POST` readings to
`/api/telemetry`. The handler evaluates them against the `ThresholdRule` rows in
the database, writes a telemetry stream row, updates the latest snapshot, and
raises alerts — plus an emergency work order when a reading is critical. The
dashboard and elevator screens read that state over REST and **poll**; there is
no push channel (see [Known Gaps](#known-gaps)).

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| **Framework** | Next.js 14 (App Router, TypeScript) — route handlers, no Server Actions |
| **UI** | Tailwind CSS, Lucide Icons, Recharts |
| **Database** | PostgreSQL with Prisma ORM |
| **Auth** | NextAuth.js (credentials) with role-based access control |
| **Validation** | Zod (shared enum definitions between frontend and runtime schemas) |
| **Predictive** | TypeScript statistical degradation model |

> Earlier revisions of this file advertised Socket.io, BullMQ/Redis and
> TanStack Query. None of those are imported anywhere in `src/`; the dependency
> entries and the claims have been removed rather than left to mislead.

---

## 📁 Project Structure

```
elevator-pulse/
├── prisma/
│   ├── schema.prisma          # Database schema (17 models)
│   └── seed.ts                # Buildings, elevators, users, components, error
│                              # codes (upserted — incidents reference them)
├── scripts/
│   ├── simulate-iot.ts        # IoT telemetry simulator (npm run simulate-iot)
│   └── diagnose-auth.ts       # Auth/credential troubleshooting helper
├── src/
│   ├── app/
│   │   ├── (auth)/login/      # Login page with role-based demo access
│   │   ├── (dashboard)/
│   │   │   ├── layout.tsx     # App shell (sidebar, header, alert badge)
│   │   │   ├── dashboard/     # KPIs, fleet overview, telemetry chart
│   │   │   ├── client/        # Occupant portal — French, guided troubleshooting
│   │   │   └── admin/incidents/  # Dispatch board: escalations + technician roster
│   │   ├── elevators/         # Fleet list + [id] detail (telemetry, RUL, specs)
│   │   ├── work-orders/       # Kanban board + list view
│   │   ├── technician/        # Mobile-friendly field portal
│   │   ├── inspection-reports/[id]/  # Printable, chrome-free service report
│   │   ├── api/               # Route handlers (see API Reference)
│   │   ├── layout.tsx         # Root layout + session provider
│   │   ├── error.tsx          # Error boundary
│   │   ├── not-found.tsx      # 404 page
│   │   └── globals.css        # Tailwind + custom animations
│   ├── components/
│   │   ├── admin/dispatch-modal.tsx      # Technician picker, least-loaded first
│   │   ├── client/emergency-button.tsx   # Non-reader path: no text required
│   │   ├── client/incident-wizard.tsx    # FR troubleshooting: code → steps → outcome
│   │   ├── layout/app-shell.tsx   # Sidebar + header, shared by every screen
│   │   ├── layout/notification-bell.tsx  # Own notifications, separate from alerts
│   │   ├── providers/             # SessionProvider wrapper
│   │   ├── technician/signature-pad.tsx  # Canvas + typed fallback
│   │   └── ui/                    # Card, states, progress-track, validation-badge
│   ├── middleware.ts          # Coarse route gate (see Roles & Access)
│   ├── lib/
│   │   ├── ai/predictive-engine.ts    # RUL calculation + risk scoring
│   │   ├── api/http.ts                # Error contract, pagination, body parsing
│   │   ├── api/guard.ts               # requireSession / requireRole
│   │   ├── auth/options.ts            # NextAuth configuration
│   │   ├── config/env.ts              # Validated server environment
│   │   ├── db/prisma.ts               # Prisma client singleton
│   │   ├── ids.ts                     # Collision-resistant order/report numbers
│   │   ├── incidents/progress.ts      # Status → stage/percent/badge, one source
│   │   ├── incidents/error-code-catalogue.ts  # FR guidance, seed + fixtures
│   │   ├── iot/thresholds.ts          # DB-backed threshold loading + caching
│   │   ├── notifications/service.ts   # notify / notifyMany / notifyRoles
│   │   ├── ui/status-styles.ts        # Shared status colour tokens
│   │   ├── work-orders/service.ts     # Work order creation + dedup rules
│   │   └── utils.ts                   # cn(), formatting helpers
│   └── types/
│       ├── index.ts           # Domain enums as `as const` tuples
│       └── next-auth.d.ts     # Session/JWT augmentation
├── .eslintrc.json
├── .prettierrc
├── docker-compose.yml         # Postgres + Redis for local development
├── package.json
├── tsconfig.json
├── tailwind.config.ts
├── next.config.js
└── .env.example
```

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** ≥ 18.17
- **PostgreSQL** ≥ 14 (16 via `docker-compose.yml`) — *optional for a UI-only
  preview; see [Running Without a Database](#running-without-a-database-ui-preview)*
- **npm**

### Step 1: Install

```bash
npm install
```

### Step 2: Configure Environment

```bash
cp .env.example .env
```

Then generate a real session secret — the app **refuses to start in production
without one**:

```bash
openssl rand -base64 32
```

Minimum contents of `.env`:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/elevator_pulse?schema=public"
NEXTAUTH_SECRET="<output of openssl rand -base64 32>"
NEXTAUTH_URL="http://localhost:3000"
# Strongly recommended in production: when set, POST /api/telemetry requires
# `Authorization: Bearer <token>`. The simulator sends it automatically.
IOT_INGEST_TOKEN=""
```

Validate everything at once:

```bash
curl http://localhost:3000/api/health
# { "status": "ok", "checks": { "database": true }, "timestamp": "..." }
```

### Step 3: Set Up the Database

Start PostgreSQL first — the failure mode if you skip this is a `P1001` "Can't
reach database server" on the next command, not a helpful message:

```bash
docker compose up -d          # Postgres (and Redis, currently unused)
```

Then, once `DATABASE_URL` in `.env` points at a running server:

```bash
npx prisma generate           # Prisma Client types (also runs on npm install)
npx prisma db push            # create the schema
npx prisma db seed            # demo accounts, buildings, elevators, error codes
```

`npx prisma db seed` runs `tsx prisma/seed.ts`, the same file as
`npm run db:seed` — the `prisma.seed` block in `package.json` is what makes the
CLI form work. Every script in the [Scripts](#-scripts) table is an equivalent
`npm run` alias.

To confirm the seed landed, the script prints its own summary on completion,
including the three technician accounts and their dispatch statuses:

```
    Tech 1:  tech1@elevatorpulse.com   (AVAILABLE)
    Tech 2:  tech2@elevatorpulse.com   (ON_JOB)
    Tech 3:  tech3@elevatorpulse.com  (ON_LEAVE — not dispatchable)
```

Tech 3 exists precisely so the roster's status filter is checkable: sign in as
`manager@elevatorpulse.com` and open **Admin → Incidents**, and the dispatch
dialog must list two technicians, not three.

> If you already have a database from an earlier revision, re-run `db:push`
> (or generate a migration). The schema gained indexes that the access-control
> and list queries depend on: `buildings.owner_id`, and
> `inspection_reports.(submitted_at)`, `.(technician_id, submitted_at)`,
> `.(elevator_id)`, `.(work_order_id)`. Without them, owner-scoped reads and
> every page of the inspection-report list fall back to sequential scans.
>
> It also gained `users.status` (`TechnicianStatus`). That push is safe on a
> populated table: the column's default is `AVAILABLE`, so existing technician
> rows become dispatchable, which is what they were before the column existed.
> The seed is what puts tech2 on a job and tech3 on leave.

### Step 4: Run

```bash
npm run dev
```

Open **http://localhost:3000**.

### Step 5: Run the IoT Simulator (optional)

In a second terminal:

```bash
npm run simulate-iot
```

Injecting readings every 2 seconds, including periodic anomaly spikes so that
alerting and emergency work order generation can be observed.

### Demo Login

| Role | Email | Password |
|------|-------|----------|
| Admin | admin@elevatorpulse.com | password123 |
| Maintenance Manager | manager@elevatorpulse.com | password123 |
| Field Technician | tech1@elevatorpulse.com | password123 |
| Building Owner | owner@metroplaza.com | password123 |

> These are seed credentials for local development only. Change or remove them
> before any deployment.

### Running Without a Database (UI preview)

If PostgreSQL is not available — no Docker, no local server — the app can still
be browsed with populated screens. Two `.env` flags control this, and **both are
ignored unconditionally when `NODE_ENV=production`**, so neither can follow the
project to a deployment.

> **Both ship as `"false"` in `.env` and `.env.example`.** They are escape
> hatches for browsing the UI, not defaults. With `OPEN_ACCESS` on, every caller
> is a synthetic ADMIN — so the role checks, the dispatch restriction and the
> tenant scoping on incidents, notifications and the technician roster are never
> exercised, and a fixture cannot validate a Prisma query. Verification against
> a real database requires them off.

```env
# Treat every request as a signed-in ADMIN; skip the login screen entirely.
OPEN_ACCESS="true"

# When a read cannot reach PostgreSQL, serve an in-memory fixture instead of
# failing, so the dashboard, fleet list and work orders render.
DEMO_DATA="true"
```

With both set, open **http://localhost:3000** and you are taken straight to a
fully populated dashboard. The sidebar shows an amber **Open** badge in place of
the sign-out button to make the mode visible.

What each flag does and does not do:

| | Effect | Where |
|---|---|---|
| `OPEN_ACCESS` | Short-circuits the session lookup. Credentials, the login form and the NextAuth flow are untouched and still work. | `src/lib/auth/open-access.ts` |
| `DEMO_DATA` | A *fallback* only. Every route runs its real query first and reaches for the fixture **inside its `catch`**, and **only** for connection failures (`P1001`, `P1002`, `ECONNREFUSED`, …) — never for a constraint violation or a malformed query, which must still surface as errors. | `src/lib/demo/` |

Point `DATABASE_URL` at a seeded database and the fixtures stop being consulted
entirely; there is nothing to switch off. Remove `OPEN_ACCESS` and the normal
login screen returns.

> **Why `DEMO_DATA` is opt-in and dev-only.** Silently serving invented telemetry
> and alert history during a database outage would let a real elevator fault
> disappear behind fabricated "all normal" readings — the precise failure this
> platform exists to catch. It is a development convenience, not an outage
> strategy: in production an unreachable database returns **503
> `DATABASE_UNAVAILABLE`**, never fixtures.

---

## 📡 API Reference

Every endpoint requires an authenticated session unless noted. Role
requirements are enforced **in the handler**, not only by middleware.

### Health

```bash
GET /api/health      # public; 200 when the database answers, 503 otherwise
```

### Telemetry Ingestion

```bash
# Public, but requires `Authorization: Bearer $IOT_INGEST_TOKEN` when set.
POST /api/telemetry
Content-Type: application/json

{
  "elevatorCode": "EP-BLD01-EL01",
  "data": {
    "motorVibrationMmS": 3.2,
    "motorTemperatureC": 72.5,
    "doorCycleCount": 145500,
    "doorSpeedMs": 0.82,
    "cabinLoadKg": 1800,
    "levelingOffsetMm": 1.5,
    "operatingHours": 12500,
    "brakeActuations": 43750
  }
}

# Response:
{ "success": true, "streamId": "...", "alertsGenerated": 0, "alerts": [] }
```

> `GET /api/telemetry` requires an authenticated session with an ops role or
> `BUILDING_OWNER`, and is portfolio-scoped for owners. (Only `POST` is on the
> middleware's anonymous allow-list — devices authenticate with the bearer
> token instead.)
>
> The cabin-overload threshold is derived from each elevator's own
> `maxPayloadKg`, not a fleet-wide constant. Because that bound is a property
> of the machine, a `cabin_load_kg` row in `ThresholdRule` is **not** consulted
> — see `payloadThresholds` in `src/lib/iot/thresholds.ts`.

### Work Orders

```bash
GET   /api/work-orders?status=OPEN&priority=HIGH&page=1&limit=20
POST  /api/work-orders              # ops roles
PATCH /api/work-orders?id=clx...    # assignee or manager/admin
POST  /api/work-orders/dispatch     # managers/admins; serializable, race-safe
```

Transitions are validated against a legal-transition map, and a work order
cannot be moved to `ASSIGNED` without an assignee.

### Inspection Reports

```bash
POST /api/inspection-reports
{
  "workOrderId": "clx...",
  "summary": "Optional free text",
  "items": [
    { "checkName": "Brake assembly thermal check", "result": "PASS",
      "photoUrl": "https://…/brake-plate.jpg" },
    { "checkName": "Motor winding resistance test", "result": "NEEDS_ATTENTION",
      "notes": "Slightly high", "measuredValue": 12.4, "unit": "Ω" }
  ],
  "signatures": [
    { "role": "TECHNICIAN", "name": "Priya Nair", "method": "DRAWN",
      "imageDataUrl": "data:image/png;base64,…" }
  ]
}

GET /api/inspection-reports?workOrderId=clx...   # the report for one job
GET /api/inspection-reports?id=clx...            # one report, for the printable view
GET /api/inspection-reports?page=1&limit=20      # recent reports
```

`overallResult` is derived as the worst item outcome (FAIL > NEEDS_ATTENTION >
PASS), so a single failure cannot be averaged away.

`signatures[].imageDataUrl` is a canvas capture and is capped at **200 KB**;
`.max(4)` signatures per report. `method: "TYPED"` records a name with no image,
which is a legitimate result — a technician finishing a job in a plant room will
not produce a legible stroke on a phone screen, and a report is not invalid for
want of one.

Filing a report notifies the building's owner (`inspection` type), and a report
whose `overallResult` is `FAIL` additionally notifies whoever raised the work
order — falling back to the management roles when that account has since been
deleted.

`?workOrderId=` returns `null` when the job has not been signed off yet, which
is the normal state of an order in flight — absence is not an error there. An
unknown `?id=`, by contrast, is a 404, and a `BUILDING_OWNER` can only reach
reports on its own portfolio: the scope is applied inside the query, so a report
belonging to another customer reads as missing rather than as forbidden.

All three `GET` forms have a `DEMO_DATA` fixture, derived from the demo world's
completed work orders rather than from hand-written report rows.

### Incidents

The customer's own unit of experience, as distinct from a work order. Most
incidents never become work at all.

```bash
POST  /api/incidents                 # ops roles + BUILDING_OWNER; the client portal
GET   /api/incidents?mine=true&limit=25
GET   /api/incidents?status=ESCALATED
GET   /api/incidents/[id]
PATCH /api/incidents/[id]            # { action: "dispatch", technicianId } …
                                     # … or { action: "status", status, notes }
```

| Status | Meaning | Badge |
|---|---|---|
| `ESCALATED` | Reported and unresolved. The default. | 🔴 Non Validé / Escaladé |
| `TECHNICIAN_ASSIGNED` | Dispatch chose an attendee. | 🔴 Non Validé / Escaladé |
| `IN_PROGRESS` | Someone is on site. | 🔴 Non Validé / Escaladé |
| `CLOSED` | Attended and finished. | 🔵 Résolu par technicien |
| `RESOLVED_BY_CLIENT` | The occupant followed the error code's guidance and it cleared. | 🟢 Résolu par client |

The badge is a verdict on *how* the fault closed, and it is derived from the
status rather than stored beside it — `incidentValidation()` in
`src/lib/incidents/progress.ts` is the only place the mapping lives, so the
board, the client portal and the work-order list cannot disagree about it. Only
`CLOSED` and `RESOLVED_BY_CLIENT` are terminal.

`isDirectTransfer` marks an incident created by the emergency button — the
occupant never read the guidance, so it is escalated without a fault code.

**Dispatching is a management act** (`ADMIN`, `MAINTENANCE_MANAGER`), enforced
in the handler rather than only on the button. The incident and its work order
move in one transaction under `Serializable` isolation, with the current status
as a write precondition, so two dispatchers clicking at once cannot both assign
it. Ownership transitions are checked in `advanceStatus` — a technician may
progress only their own job, and only the reporting client may resolve an
incident themselves.

The chosen technician must also be **dispatchable**. The roster hides anyone
`ON_LEAVE` or `OFF_DUTY`, but the rule is enforced on the write, not by the
list: a dispatch dialog holds the roster it fetched, and a request can be made
by hand. The same eligibility check guards the three other places work can be
assigned — `POST`/`PATCH /api/work-orders` (`assignedToId`) and both directions
of `POST /api/work-orders/dispatch`. It lives once, in
`assignableUserWhere()` (`src/lib/api/guard.ts`).

### Technicians (dispatch roster)

```bash
GET /api/technicians    # ADMIN / MAINTENANCE_MANAGER only
```

Active `FIELD_TECHNICIAN` users whose recorded `status` is **dispatchable**,
least-loaded first, with counts of open work orders (`ASSIGNED`, `IN_PROGRESS`,
`ON_HOLD`) and open incidents.

Reachability is a stored fact (`User.status`), and load is a derived one. Both
matter and they are not the same question: `AVAILABLE` and `ON_JOB` are
dispatchable — a technician already on a job can have work queued behind it —
while `OFF_DUTY` and `ON_LEAVE` are not, and are excluded by the query rather
than greyed out in the UI. The shared pair lives in
`DISPATCHABLE_TECHNICIAN_STATUSES` (`src/types/index.ts`) so the route and the
demo fixture cannot disagree about it.

### Error Codes

```bash
GET /api/error-codes              # the full catalogue
GET /api/error-codes?q=E-4        # filtered by code, title or description
```

Feeds the client portal's troubleshooting wizard. The same catalogue lives in
`src/lib/incidents/error-code-catalogue.ts`, consumed by both `prisma/seed.ts`
and the demo fixtures so the guidance cannot differ between them.

### Notifications

```bash
GET   /api/notifications?limit=8          # the caller's own, newest first
                                          # → { data, total, unread, page, limit }
PATCH /api/notifications                  # { "id": "clx…" }  — mark that one read
PATCH /api/notifications                  # { "all": true }   — mark every one read
```

The write body is `.strict()`: `{ id }` or `{ all: true }` and nothing else —
there is no `read` flag to set, because marking a notification read is the only
mutation the model carries.

Every user only ever sees their own. Notifications are written **after** the
transaction commits, never inside it — a notification is a courtesy, never a
precondition, so a failure to write one must not roll back the incident that
caused it.

### Predictive Analysis

```bash
POST /api/predictive                  # managers/admins
{ "elevatorId": "clx..." }            # single
{ "batch": true }                     # fleet-wide (capped at 500 elevators)
{ "batch": true, "dryRun": true }     # analyse without persisting

GET /api/predictive?elevatorId=clx... # latest scores
GET /api/predictive?riskLevel=HIGH    # fleet-wide, worst component per unit
```

The batch cap is a server constant (`MAX_BATCH_SIZE`), not a request field —
the body schema is `.strict()`, so an extra key is a 400.

### Buildings, Elevators, Dashboard, Alerts, Technician

```bash
GET   /api/buildings                 POST /api/buildings
GET   /api/elevators                 POST /api/elevators
GET   /api/elevators/[id]            # specs, components, telemetry, RUL, orders, alerts

GET   /api/dashboard                 # KPIs, building health, alerts, telemetry feed
GET   /api/alerts?acknowledged=false&resolved=false&page=1&limit=20
PATCH /api/alerts?id=xxx             # { "acknowledged": true } or { "resolved": true }

GET   /api/technician                # active + completed-today assignments
GET   /api/technician?technicianId=xxx   # managers/admins only
```

A `FIELD_TECHNICIAN` always receives their own queue — the `technicianId`
parameter is ignored for that role.

---

## 🔧 IoT Simulator

`scripts/simulate-iot.ts` generates telemetry for five elevators with distinct
degradation profiles, periodic anomaly spikes, and gaussian sensor noise.

| Metric | Normal Range | Anomaly Behaviour |
|--------|-------------|-------------------|
| Motor Vibration | 1.5–3.5 mm/s | Spikes to 7–10 mm/s |
| Motor Temperature | 55–75 °C | Rises to 90–110 °C |
| Door Speed | 0.7–0.9 m/s | Degrades over time |
| Cabin Load | 200–3500 kg | Time-of-day pattern |
| Leveling Offset | ±3 mm | Degrades with age |

---

## 🧠 Predictive Engine

`src/lib/ai/predictive-engine.ts` implements a statistical degradation model.
`MODEL_VERSION` is stamped onto every persisted score so results are traceable.

### RUL Algorithm

```
RUL% = clamp(0, 100, 100 - (effectiveWear / baseLifeHours) × 100)

effectiveWear = currentLifeHours
              + (vibrationExcess × vibrationFactor × currentLifeHours)
              + (temperatureExcess × temperatureFactor × currentLifeHours)
              + (doorCycles × cycleFactor × 0.001)

vibrationExcess   = max(0, avgVibration - 2.5 mm/s)
temperatureExcess = max(0, avgTemperature - 65 °C)
```

A component's own `expectedLifeHours` (nameplate) overrides the generic
`baseLifeHours` from the table below.

### Component Models

| Component | Base Life | Vibration Factor | Temperature Factor | Cycle Factor |
|-----------|-----------|------------------|--------------------|--------------|
| Traction Motor | 60,000 hrs | 0.15 | 0.12 | — |
| Steel Ropes | 50,000 hrs | 0.08 | 0.05 | 0.10 |
| Door Operator | 40,000 hrs | 0.05 | 0.03 | 0.20 |
| Brake Assembly | 45,000 hrs | 0.10 | 0.08 | 0.12 |
| Guide Shoes | 35,000 hrs | 0.18 | 0.04 | 0.06 |
| Controller Board | 80,000 hrs | 0.03 | 0.15 | — |

### Risk Classification

`riskScore = 100 - RUL%`, plus 15 points when vibration exceeds baseline by
>3 mm/s and 10 points when temperature exceeds baseline by >20 °C.

| Risk Level | RUL | Risk Score |
|-----------|-----|-----------|
| 🟢 LOW | > 50% | < 45 |
| 🟡 MEDIUM | 25–50% | 45–70 |
| 🟠 HIGH | 10–25% | 70–90 |
| 🔴 CRITICAL | ≤ 10% | ≥ 90 |

CRITICAL components raise an emergency work order, deduplicated per
(elevator, component, metric) while an alert for that metric is unresolved.

### Degradation Trend

Each component carries a `riskTrend` of `new` / `improving` / `stable` /
`worsening`, computed against the previous analysis of the same elevator.

The comparison reads the prior `PredictiveScore` rows **before** the current run
upserts its own — otherwise the run would be comparing its results to itself and
every component would read as `stable`. Two things count as worsening: a climb
in risk *level* (`HIGH` → `CRITICAL`), or a climb of ≥ 10 points in risk score
at an unchanged level, which is roughly the gap between two adjacent bands.

A worsening component that already has an open predictive order is then
escalated in place: priority raised to `CRITICAL`, description refreshed with
the current figures, and the scheduled date moved to **three days before** the
newly predicted failure date (`ESCALATION_SAFETY_BUFFER_DAYS`). A first visit
gets a seven-day lead; an escalation gets three, because the component was
already judged worth a visit and has deteriorated regardless — but the
technician still arrives *before* the failure rather than on the day of it. The
buffer is applied to each newly predicted date, so a still-worsening component
moves again on the next run rather than being pinned.

The assigned technician is sent a `Notification` naming the old and new dates,
so a visit that moved on them says so — the one case where silently re-booking
would be worst. A technician who was already assigned is notified on any of
those three changes; an unassigned order falls back to the management roles, as
everywhere else. `POST /api/predictive` reports what happened as
`workOrdersEscalated`, `escalatedWorkOrderIds` and `worseningCount`.

### Python Reference Service

`src/lib/ai/python/predictive_api.py` is a standalone FastAPI/Scikit-learn
sketch. **It is not wired into the application** — nothing in `src/` calls it.
Treat it as a design reference for a future ML microservice.

---

## 🗃️ Database Schema

### Core Entities (17 models)

```
User ──┬── Session
       ├── Notification
       ├── InspectionReport ── InspectionCheckItem
       ├── IncidentReport (as client)    ──┐
       └── IncidentReport (as technician) ─┤
                                           │
Building ──┬── Elevator ──┬── ElevatorComponent ── PredictiveScore
           │              ├── TelemetryStream
           │              ├── TelemetrySnapshot
           │              ├── MaintenanceSchedule
           │              ├── PredictiveScore
           │              ├── Alert ── ThresholdRule
           │              ├── InspectionReport
           │              ├── IncidentReport ── ErrorCode
           │              └── WorkOrder ──┬── Alert
           └── User (owner)               └── IncidentReport (0..1)
```

`IncidentReport` carries **two** relations to `User` — the client who reported
the fault and the technician sent to it — so both are explicitly named
(`ClientIncidents`, `TechnicianIncidents`). `WorkOrder.incident` is the back
side of a one-to-one: an incident raises at most one work order, and most raise
none.

### Key Enums

- **UserRole**: ADMIN, MAINTENANCE_MANAGER, FIELD_TECHNICIAN, BUILDING_OWNER
- **ElevatorStatus**: OPERATIONAL, SERVICE_REQUIRED, ANOMALY_DETECTED, CRITICAL_SHUTDOWN, OFFLINE
- **WorkOrderStatus**: OPEN, ASSIGNED, IN_PROGRESS, ON_HOLD, COMPLETED, CANCELLED
- **WorkOrderType**: PREVENTIVE, PREDICTIVE, CORRECTIVE, EMERGENCY, INSPECTION
- **ComponentType**: TRACTION_MOTOR, BRAKE_ASSEMBLY, DOOR_OPERATOR, STEEL_ROPES, GUIDE_SHOES, CONTROLLER_BOARD, COUNTERWEIGHT, CABIN, HYDRAULIC_UNIT, SAFETY_GEAR, BUFFER, OTHER
- **IncidentStatus**: ESCALATED, TECHNICIAN_ASSIGNED, IN_PROGRESS, CLOSED, RESOLVED_BY_CLIENT
- **InspectionCheckResult**: PASS, FAIL, NEEDS_ATTENTION, NOT_APPLICABLE
- **TechnicianStatus**: AVAILABLE, ON_JOB, OFF_DUTY, ON_LEAVE — carried by
  `User.status`, defaulting to `AVAILABLE`

Two of these enum *orders* carry meaning, because PostgreSQL orders enums by
declaration order and the UI relies on it. `IncidentStatus` is declared in
**pipeline order**, not alphabetically: the incident board's default
`orderBy: { status: "asc" }` depends on it, and `RESOLVED_BY_CLIENT` sits last
on purpose — it is "finished, but finished without us". `TechnicianStatus` is
declared in **availability order**, so `AVAILABLE` and `ON_JOB` (dispatchable)
sort ahead of `OFF_DUTY` and `ON_LEAVE` (not).

All enum values are declared once in `src/types/index.ts` as `as const` tuples,
so the TypeScript types and the Zod validation schemas cannot drift apart.

---

## 👥 Roles & Access

Authorisation has two layers, and the **handler-level guards in
`src/lib/api/guard.ts` are the authoritative one**:

1. `src/middleware.ts` — a coarse gate that keeps anonymous traffic out of
   `/api/*` and the app screens. It exempts `POST /api/telemetry` (IOT) and
   `/api/health` only.
2. `requireRole(...)` inside each handler — the real boundary, enforced per
   route and per action.

| Role | Capabilities |
|------|-------------|
| **Admin** | Full access; may reassign work, dispatch incidents, run fleet-wide analysis, manage records |
| **Maintenance Manager** | Same operational scope as Admin for work orders, dispatch, incidents and analysis |
| **Field Technician** | Own queue only; updates own work orders, files inspection reports, progresses incidents assigned to them; cannot reassign or dispatch |
| **Building Owner** | Read-only and portfolio-scoped; may report and self-resolve incidents from the client portal |

Two screens carry their own gates in `src/middleware.ts` on top of the
handler-level checks, because both would otherwise leak across tenants:
`/technician` (ops roles only) and `/admin/*` (management only — a building
owner who reached it would see every other customer's incidents and the
company's staffing).

`/client` is deliberately **not** role-gated. A building owner is its intended
user, but an administrator has to be able to open it to see what a customer
sees; the incident API scopes every read to the caller, so an admin sees an
admin's view of the same screen.

**A `BUILDING_OWNER` is a customer account, not staff.** It is confined to its
own portfolio on *every* read endpoint — `/api/dashboard`, `/api/buildings`,
`/api/elevators`, `/api/elevators/[id]`, `/api/work-orders`, `/api/alerts`,
`/api/predictive`, `/api/telemetry` and `/api/inspection-reports` — through the
single `buildingScopeFor` helper in `src/lib/api/guard.ts`. Any new
owner-readable route must route its queries through it; a route that authorises
`BUILDING_OWNER` without it hands one customer another customer's site
contacts and inspection history.

A `FIELD_TECHNICIAN` always receives their own queue — the `technicianId`
parameter is ignored for that role, and they can only read and update work
orders assigned to them.

---

## 📜 Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Next.js development server |
| `npm run build` | Build production bundle |
| `npm run start` | Serve the production build |
| `npm run lint` | Run ESLint (`next lint`) |
| `npm run db:push` | Push Prisma schema to database |
| `npm run db:migrate` | Run Prisma migrations |
| `npm run db:generate` | Regenerate the Prisma client |
| `npm run db:seed` | Seed database with sample data |
| `npm run db:studio` | Open Prisma Studio |
| `npm run simulate-iot` | Start the IoT telemetry simulator |

---

## 🚧 Known Gaps

Recorded here rather than left implied, since the platform is presented as
production-ready in places where it is not yet:

- **Deterioration escalation re-schedules the visit.** When a component already
  covered by an open predictive order gets worse, the order's priority is
  raised to `CRITICAL`, its description refreshed with the current figures, its
  scheduled date moved to three days before the *new* predicted failure date,
  and the assignee notified with the old and new dates. The re-schedule is
  deliberate: the point of the prediction is to arrive before the failure, and
  the failure moved. But it does overwrite a date a technician may already have
  planned their week around, and the three-day buffer is a **policy choice, not
  a technical one** — ratified at three days, revisitable at
  `ESCALATION_SAFETY_BUFFER_DAYS` in `src/lib/ai/predictive-engine.ts`, which is
  the single place the lead time is defined.

- **No push channel.** Dashboards poll — 30 s for the dashboard, 45 s for the
  incident board. There is no WebSocket or SSE layer; an in-memory pub/sub stub
  that could never work across multiple instances has been deleted rather than
  left to imply otherwise.
- **No automated tests and no CI.** There is no test runner configured. The
  verification in this revision was `npm run typecheck`, `npm run lint` and a
  manual walk of each screen against a live database.
- **Photo evidence is a URL, not an upload.** `InspectionCheckItem.photoUrl` is
  now written, but the technician portal accepts a link to a file in the
  customer's own photo storage — there is no upload endpoint, no object-store
  integration and no image processing. Attaching from the device camera is the
  gap the field actually feels.
- **The inspection-report fixture is derived, not seeded.** With
  `DEMO_DATA="true"` `/api/inspection-reports` now answers from reports built
  off the demo world's completed work orders rather than from rows, so a demo
  report can be read but never written — `POST` still requires a database, as it
  should. With the flag off (the default) an unreachable database still returns
  503 `DATABASE_UNAVAILABLE`.
- **Recurring maintenance generation** is not implemented; `MaintenanceSchedule`
  rows are data only.
- **Unused dependencies.** `socket.io`, `socket.io-client`, `bullmq`,
  `ioredis`, `@tanstack/react-query`, the `@radix-ui/*` packages and
  `class-variance-authority` are declared but never imported. Remove them with:
  ```bash
  npm uninstall socket.io socket.io-client bullmq ioredis @tanstack/react-query \
    @radix-ui/react-dialog @radix-ui/react-dropdown-menu @radix-ui/react-select \
    @radix-ui/react-tabs @radix-ui/react-toast @radix-ui/react-slot \
    class-variance-authority
  ```
- **No Content-Security-Policy.** Next.js injects inline bootstrap scripts, so a
  real CSP needs per-request nonces threaded through the middleware.

---

## 📄 License

MIT — see [`LICENSE`](./LICENSE).
