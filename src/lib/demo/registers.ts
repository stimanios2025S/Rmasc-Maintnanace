/**
 * Jeux de démonstration pour les registres qui n'en avaient pas.
 *
 * POURQUOI CE FICHIER EXISTE
 * Trois écrans dépendent de routes qui n'avaient aucun repli : la reprise
 * d'appareil (liste des immeubles), la création d'un contrat (liste des
 * clients) et le registre des factures. Sans PostgreSQL, ces routes répondaient
 * 503 et les sélecteurs restaient vides — un écran qui ressemble à une panne
 * alors que la base est simplement absente.
 *
 * Ce ne sont pas de nouvelles règles métier : les lignes sont dérivées du même
 * monde que `demoWorld()`, avec les mêmes immeubles, les mêmes comptes et les
 * mêmes interventions terminées. Une facture de démonstration pointe donc sur
 * un bon qui existe vraiment dans la fixture, et sur le client qui possède
 * l'immeuble.
 *
 * LECTURE SEULE
 * Comme tout le reste de `src/lib/demo/`, ces fixtures ne servent que des
 * lectures. Les écritures continuent d'exiger une base — voir la note dans
 * `src/lib/demo/mode.ts`.
 */

import type { InvoiceStatus } from "@prisma/client";
import { demoWorld } from "./dataset";
import {
  effectiveEndsAt,
  effectiveStatus,
  expiryAlert,
} from "@/lib/contracts/status";
import type { CoverageContract } from "@/lib/contracts/coverage";
import type { ContractRenewalMode, ContractStatus, SLATier } from "@/types";

// ─── Immeubles ──────────────────────────────────────────────

export interface DemoBuildingRow {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string | null;
  slaTier: string;
  contactPerson: string;
  contactEmail: string | null;
  contactPhone: string | null;
  latitude: number | null;
  longitude: number | null;
  elevatorCount: number;
  avgHealth: number;
  statusBreakdown: Record<string, number>;
}

/**
 * La liste des immeubles, dans la forme exacte de `GET /api/buildings`.
 *
 * Les compteurs sont recalculés depuis les appareils de la fixture plutôt que
 * écrits à la main : c'est ce que fait la route, et une fixture qui
 * annoncerait trois appareils sur un immeuble qui en a deux rendrait le
 * sélecteur de reprise incohérent avec le parc affiché ailleurs.
 */
export function demoBuildingRows(): DemoBuildingRow[] {
  const { buildings, elevators } = demoWorld();

  return buildings
    .map((building) => {
      const units = elevators.filter(
        (elevator) => elevator.buildingId === building.id && elevator.isActive
      );

      return {
        id: building.id,
        name: building.name,
        address: building.address,
        city: building.city,
        state: building.state,
        slaTier: building.slaTier,
        contactPerson: building.contactPerson,
        contactEmail: building.contactEmail,
        contactPhone: building.contactPhone,
        latitude: building.latitude,
        longitude: building.longitude,
        elevatorCount: units.length,
        avgHealth:
          units.length > 0
            ? Math.round(
                units.reduce((sum, unit) => sum + unit.overallHealth, 0) /
                  units.length
              )
            : 0,
        statusBreakdown: units.reduce<Record<string, number>>((acc, unit) => {
          acc[unit.status] = (acc[unit.status] ?? 0) + 1;
          return acc;
        }, {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

// ─── Comptes clients ────────────────────────────────────────

export interface DemoClientAccount {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  address: string | null;
  clientType: string | null;
  isActive: boolean;
  createdAt: string;
  _count: { ownedBuildings: number; technicalSheets: number };
  /**
   * Le parc résumé, comme `CLIENT_SELECT` le sert à la liste d'administration.
   *
   * La vue d'ensemble affiche les immeubles, leur contact et l'état de leurs
   * appareils sans ouvrir chaque fiche. La fixture dérivait déjà les compteurs
   * mais pas les immeubles : la liste de démonstration retombait sur un parc
   * vide, ce qui rendait le nouvel écran de gestion faux dès l'absence de base.
   */
  ownedBuildings: Array<{
    id: string;
    name: string;
    city: string;
    contactPerson: string;
    contactEmail: string | null;
    contactPhone: string | null;
    elevators: { status: string }[];
  }>;
}

/**
 * Les comptes clients, dans la forme de `GET /api/clients`.
 *
 * `technicalSheets` reste à zéro : la fixture ne contient aucune fiche
 * technique, et inventer un compteur de fiches qui n'existent nulle part
 * ferait ouvrir une liste vide depuis la fiche du client.
 */
export function demoClientAccounts(clientType?: string | null): {
  clients: DemoClientAccount[];
  total: number;
} {
  const { users, buildings, elevators } = demoWorld();

  const clients = users
    .filter(
      (user) =>
        user.role === "BUILDING_OWNER" &&
        (!clientType || user.clientType === clientType)
    )
    .map((user) => {
      const parc = buildings
        .filter((building) => building.ownerId === user.id)
        .sort((a, b) => a.name.localeCompare(b.name, "fr"))
        .map((building) => ({
          id: building.id,
          name: building.name,
          city: building.city,
          contactPerson: building.contactPerson,
          contactEmail: building.contactEmail,
          contactPhone: building.contactPhone,
          elevators: elevators
            .filter(
              (elevator) =>
                elevator.buildingId === building.id && elevator.isActive
            )
            .map((elevator) => ({ status: elevator.status })),
        }));

      return {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        address: (user as { address?: string | null }).address ?? null,
        clientType: user.clientType,
        isActive: user.isActive,
        // La colonne est un `DateTime` côté Prisma ; la route la sérialise en
        // ISO. La fixture fait de même pour que le tri de l'écran reçoive la
        // même forme qu'avec une vraie base.
        createdAt: user.createdAt.toISOString(),
        _count: {
          ownedBuildings: parc.length,
          technicalSheets: 0,
        },
        ownedBuildings: parc,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return { clients, total: clients.length };
}

// ─── Fiche d'un compte client ───────────────────────────────

/** La même borne que la route : au-delà, le sélecteur n'est plus lisible. */
const ATTACHABLE_LIMIT = 50;

export interface DemoClientAccess {
  email: string;
  clientType: string | null;
  isActive: boolean;
  /** Vrai quand le compte peut encore ouvrir une session. */
  canSignIn: boolean;
  /**
   * La réémission de mot de passe est une écriture : elle reste impossible
   * sans base. L'écran lit ce champ pour ne pas offrir un bouton qui échoue.
   */
  passwordReissueAvailable: boolean;
}

export interface DemoClientDetail {
  client: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    address: string | null;
    clientType: string | null;
    isActive: boolean;
    createdAt: string;
    ownedBuildings: Array<{
      id: string;
      name: string;
      address: string;
      city: string;
      state: string | null;
      zipCode: string | null;
      contactPerson: string;
      contactEmail: string | null;
      contactPhone: string | null;
      slaTier: string;
      latitude: number | null;
      longitude: number | null;
      geofenceRadiusM: number | null;
      elevators: Array<{
        id: string;
        elevatorCode: string;
        brand: string;
        model: string;
        serialNumber: string | null;
        motorType: string;
        controllerType: string;
        floorsServed: number;
        maxPayloadKg: number;
        installationDate: string | null;
        installationLocation: string | null;
        status: string;
        overallHealth: number;
        nextMaintenance: string | null;
      }>;
    }>;
  };
  attachable: Array<{
    id: string;
    name: string;
    address: string;
    city: string;
    owner: { id: string; name: string } | null;
    elevatorCount: number;
  }>;
  attachableTruncated: boolean;
  access: DemoClientAccess;
}

/**
 * Une fiche client complète, dans la forme exacte de `GET /api/clients/:id`.
 *
 * POURQUOI ELLE EST DÉRIVÉE DU MONDE DE DÉMONSTRATION
 * La fiche est le seul écran qui joint trois choses : le compte, ses immeubles
 * et leurs appareils. Écrire ces trois listes à la main produirait une seconde
 * vérité — un immeuble visible ici et absent de la carte, un appareil compté
 * deux fois — et c'est exactement ce que `demoWorld()` évite. Tout est donc
 * filtré depuis la même source que les autres écrans.
 *
 * Elle rend `null` pour un identifiant inconnu, et non une fiche vide : la
 * route répond alors 404, comme avec une vraie base, plutôt que de faire
 * croire à un compte qui existe.
 *
 * Les dates sont sérialisées en ISO comme le fait Prisma : l'écran reçoit la
 * même forme qu'en production et n'a pas deux façons de lire une date.
 */
export function demoClientDetail(
  clientId: string,
  query?: string | null
): DemoClientDetail | null {
  const { users, buildings, elevators } = demoWorld();

  const client = users.find(
    (user) => user.id === clientId && user.role === "BUILDING_OWNER"
  );
  if (!client) return null;

  const ownedBuildings = buildings
    .filter((building) => building.ownerId === client.id)
    .sort((a, b) => a.name.localeCompare(b.name, "fr"))
    .map((building) => ({
      id: building.id,
      name: building.name,
      address: building.address,
      city: building.city,
      state: building.state,
      zipCode: building.zipCode,
      contactPerson: building.contactPerson,
      contactEmail: building.contactEmail,
      contactPhone: building.contactPhone,
      slaTier: building.slaTier,
      latitude: building.latitude,
      longitude: building.longitude,
      geofenceRadiusM: building.geofenceRadiusM,
      elevators: elevators
        .filter(
          (elevator) =>
            elevator.buildingId === building.id && elevator.isActive
        )
        .sort((a, b) => a.elevatorCode.localeCompare(b.elevatorCode, "fr"))
        .map((elevator) => ({
          id: elevator.id,
          elevatorCode: elevator.elevatorCode,
          brand: elevator.brand,
          model: elevator.model,
          serialNumber: elevator.serialNumber,
          motorType: elevator.motorType,
          controllerType: elevator.controllerType,
          floorsServed: elevator.floorsServed,
          maxPayloadKg: elevator.maxPayloadKg,
          installationDate: elevator.installationDate
            ? elevator.installationDate.toISOString()
            : null,
          installationLocation: elevator.installationLocation,
          status: elevator.status,
          overallHealth: elevator.overallHealth,
          nextMaintenance: elevator.nextMaintenance
            ? elevator.nextMaintenance.toISOString()
            : null,
        })),
    }));

  /**
   * Les immeubles rattachables, avec les mêmes règles que la route : actifs,
   * non détenus par ce client, filtrés par la recherche, et bornés.
   *
   * La recherche est faite en mémoire parce que la fixture tient en quelques
   * lignes — mais elle porte sur les mêmes trois champs que le `contains`
   * insensible à la casse de Prisma, sinon la démonstration chercherait autre
   * chose que la production.
   */
  const needle = query?.trim().toLowerCase() ?? "";
  const candidates = buildings
    .filter((building) => building.isActive && building.ownerId !== client.id)
    .filter(
      (building) =>
        !needle ||
        [building.name, building.address, building.city].some((value) =>
          value.toLowerCase().includes(needle)
        )
    )
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));

  const attachable = candidates.slice(0, ATTACHABLE_LIMIT).map((building) => {
    const owner = building.ownerId
      ? users.find((user) => user.id === building.ownerId)
      : undefined;
    return {
      id: building.id,
      name: building.name,
      address: building.address,
      city: building.city,
      owner: owner ? { id: owner.id, name: owner.name } : null,
      elevatorCount: elevators.filter(
        (elevator) => elevator.buildingId === building.id && elevator.isActive
      ).length,
    };
  });

  return {
    client: {
      id: client.id,
      name: client.name,
      email: client.email,
      phone: client.phone,
      address: client.address,
      clientType: client.clientType,
      isActive: client.isActive,
      createdAt: client.createdAt.toISOString(),
      ownedBuildings,
    },
    attachable,
    attachableTruncated: candidates.length > ATTACHABLE_LIMIT,
    /**
     * L'état des accès, que la fiche affiche à côté du parc.
     *
     * Il est calculé, pas inventé : `canSignIn` suit `isActive`, la règle que
     * le chemin de connexion applique déjà. La réémission de mot de passe est
     * déclarée disponible parce que la route la sert en démonstration — elle
     * engendre un mot de passe sans l'écrire nulle part, et l'écran présente
     * le résultat comme une invitation simulée.
     */
    access: {
      email: client.email,
      clientType: client.clientType,
      isActive: client.isActive,
      canSignIn: client.isActive,
      passwordReissueAvailable: true,
    },
  };
}

// ─── Reprises d'appareils tiers ─────────────────────────────

export interface DemoTakeoverRow {
  id: string;
  elevatorCode: string;
  brand: string;
  originBrand: string | null;
  model: string;
  serialNumber: string | null;
  rmascCode: string | null;
  status: string;
  createdAt: string;
  /** La fiche d'état des lieux, telle que l'audit la relit. */
  installationDate: string | null;
  motorType: string;
  controllerType: string;
  maxPayloadKg: number;
  floorsServed: number;
  building: { id: string; name: string; city: string };
  workOrders: {
    id: string;
    orderNumber: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
    /** Le relevé de non-conformités consigné dans le bon d'inspection. */
    description: string | null;
  }[];
}

/**
 * Trois reprises, une par étape du parcours.
 *
 * La première a son bon d'inspection ouvert : la validation est bloquée. La
 * deuxième a été inspectée mais pas matriculée : le bouton de validation est
 * actif. La troisième est reprise et porte son matricule. Sans les trois, on ne
 * peut pas vérifier que l'écran distingue « en attente » de « prêt à valider »,
 * qui est la seule décision qu'il demande.
 */
export function demoTakeovers(): DemoTakeoverRow[] {
  const now = Date.now();
  const daysAgo = (days: number) =>
    new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

  return [
    {
      id: "tk_demo_1",
      elevatorCode: "PINS-01",
      brand: "OTHER",
      originBrand: "Otis",
      model: "Gen2",
      serialNumber: "OT-2019-4471",
      rmascCode: null,
      status: "SERVICE_REQUIRED",
      createdAt: daysAgo(12),
      installationDate: daysAgo(2100),
      motorType: "AC_GEARED",
      controllerType: "MICROPROCESSOR",
      maxPayloadKg: 630,
      floorsServed: 11,
      building: {
        id: "bld_demo_pins",
        name: "Résidence Les Pins",
        city: "Constantine",
      },
      workOrders: [
        {
          id: "wo_demo_insp_1",
          orderNumber: "INSP-2026-01",
          status: "OPEN",
          createdAt: daysAgo(11),
          completedAt: null,
          description:
            "Visite d'inspection avant reprise en maintenance de l'appareil PINS-01.\n\nNon-conformités et remarques de sécurité relevées :\nÉclairage de la machinerie défaillant, à remplacer avant mise en service.",
        },
      ],
    },
    {
      id: "tk_demo_2",
      elevatorCode: "HANA-02",
      brand: "SCHINDLER",
      originBrand: "Schindler",
      model: "3300",
      serialNumber: "SC-2020-1182",
      rmascCode: null,
      status: "SERVICE_REQUIRED",
      createdAt: daysAgo(8),
      installationDate: daysAgo(1900),
      motorType: "AC_GEARDLESS",
      controllerType: "FULLY_DIGITAL",
      maxPayloadKg: 800,
      floorsServed: 14,
      building: {
        id: "bld_demo_hana",
        name: "Tour El Hana",
        city: "Alger",
      },
      workOrders: [
        {
          id: "wo_demo_insp_2",
          orderNumber: "INSP-2026-02",
          status: "COMPLETED",
          createdAt: daysAgo(7),
          completedAt: daysAgo(3),
          description:
            "Visite d'inspection avant reprise en maintenance de l'appareil HANA-02.\n\nNon-conformités et remarques de sécurité relevées :\nPanneau de secours de la cabine hors service ; éclairage de gaine à compléter. Aucune réserve sur les organes de sécurité.",
        },
      ],
    },
    {
      id: "tk_demo_3",
      elevatorCode: "BAB-03",
      brand: "KONE",
      originBrand: "KONE",
      model: "MonoSpace",
      serialNumber: "KN-2021-7734",
      rmascCode: "ASC-2026-0088",
      status: "OPERATIONAL",
      createdAt: daysAgo(45),
      installationDate: daysAgo(2400),
      motorType: "AC_GEARED",
      controllerType: "PLC",
      maxPayloadKg: 1000,
      floorsServed: 9,
      building: {
        id: "bld_demo_bab",
        name: "Centre Affaires Bab Ezzouar",
        city: "Alger",
      },
      workOrders: [
        {
          id: "wo_demo_insp_3",
          orderNumber: "INSP-2026-03",
          status: "COMPLETED",
          createdAt: daysAgo(44),
          completedAt: daysAgo(40),
          description:
            "Visite d'inspection avant reprise en maintenance de l'appareil BAB-03.\n\nNon-conformités et remarques de sécurité relevées :\nAucune. Appareil intégré au parc après validation.",
        },
      ],
    },
  ];
}

// ─── Fiches techniques (prospects) ──────────────────────────

export interface DemoTechnicalSheetRow {
  id: string;
  elevatorId: string | null;
  clientId: string;
  clientName: string;
  location: string;
  weightCapacity: string;
  numberOfFloors: string;
  createdAt: string;
  client: {
    id: string;
    name: string | null;
    email: string;
    phone: string | null;
  };
  elevator: {
    id: string;
    elevatorCode: string;
    model: string | null;
    building: { id: string; name: string; city: string } | null;
  } | null;
  /** Les colonnes techniques optionnelles, remplies au fil des visites. */
  [key: string]: unknown;
}

/**
 * Trois fiches de prospects, à des degrés d'avancement différents.
 *
 * La première est presque complète, la deuxième partielle, la troisième
 * réduite aux quatre champs que le client connaît. C'est exactement ce que le
 * tableau doit montrer : le nombre de champs techniques restants, et lesquels
 * une visite doit relever.
 */
export function demoTechnicalSheets(): DemoTechnicalSheetRow[] {
  const now = Date.now();
  const daysAgo = (days: number) =>
    new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

  return [
    {
      id: "ts_demo_1",
      elevatorId: null,
      clientId: "usr_demo_prospect_1",
      clientName: "Clinique El Amel",
      buildingName: "Clinique El Amel",
      contactPhone: "0661 44 22 10",
      location: "12 rue des Frères Bouadou, Alger",
      weightCapacity: "630",
      numberOfFloors: "9",
      createdAt: daysAgo(6),
      client: {
        id: "usr_demo_prospect_1",
        name: "Dr. Amine Saadi",
        email: "direction@clinique-elamel.dz",
        phone: "0661 44 22 10",
      },
      elevator: {
        id: "elv_demo_clinique",
        elevatorCode: "ELAMEL-01",
        model: "GeN2",
        building: {
          id: "bld_demo_clinique",
          name: "Clinique El Amel",
          city: "Alger",
        },
      },
      serialNumber: "OT-2018-3320",
      installationDate: "2018",
      brand: "Otis",
      model: "GeN2",
      technicianName: "Samir Ould Ali",
      machineType: "Sans local machine",
      motorType: "Synchrone à aimants permanents",
      speedVariator: "Oui",
      tractionRope: "6 câbles — usure à contrôler",
      cabinDoorType: "Automatique 2 panneaux",
      display: "Afficheur LCD",
      parachuteType: "Progressif",
      travelHeight: "27 m",
    },
    {
      id: "ts_demo_2",
      elevatorId: null,
      clientId: "usr_demo_prospect_2",
      clientName: "Hôtel Es-Salam",
      buildingName: "Hôtel Es-Salam",
      contactPhone: "0550 77 31 88",
      location: "Boulevard de la Soummam, Oran",
      weightCapacity: "1000",
      numberOfFloors: "12",
      createdAt: daysAgo(3),
      client: {
        id: "usr_demo_prospect_2",
        name: "Nadia Belkacem",
        email: "technique@hotel-essalam.dz",
        phone: "0550 77 31 88",
      },
      elevator: null,
      serialNumber: "SC-2016-0912",
      brand: "Schindler",
      model: "5500",
      machineType: "Local machine en toiture",
      motorType: "Asynchrone",
      brakingResistor: "Présente",
      chassis: "Treuil à poulie",
      emergencyLight: "Oui",
      soundSignal: "Bip de surcharge",
    },
    {
      id: "ts_demo_3",
      elevatorId: null,
      clientId: "usr_demo_prospect_3",
      clientName: "Nadia Boumediene",
      buildingName: "Syndic Les Oliviers",
      contactPhone: "0770 12 45 67",
      location: "45 boulevard de la Soummam, Oran",
      weightCapacity: "450",
      numberOfFloors: "6",
      createdAt: daysAgo(1),
      client: {
        id: "usr_demo_prospect_3",
        name: "Nadia Boumediene",
        email: "syndic.oliviers@email.dz",
        phone: "0770 12 45 67",
      },
      elevator: null,
      brand: "KONE",
      model: "MonoSpace",
      speedVariator: "Oui — 4 kW",
    },
  ];
}

// ─── Demandes d'accès (QR) ──────────────────────────────────

export interface DemoAccessRequestRow {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  role: string;
  message: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  decidedAt: string | null;
  createdAt: string;
  elevator: {
    id: string;
    elevatorCode: string;
    building: { id: string; name: string; city: string };
  };
  decidedBy: { id: string; name: string } | null;
  createdUser: { id: string; name: string; email: string } | null;
}

/**
 * Trois demandes d'accès, une par état.
 *
 * POURQUOI LES TROIS, ET PAS SEULEMENT CELLE QUI ATTEND
 * L'écran de décision ne montre ses boutons que sur une demande en attente. En
 * démonstration, ne fournir qu'une ligne PENDING laisserait les onglets
 * « Approuvées » et « Refusées » vides — impossible de vérifier qu'une décision
 * s'affiche correctement, ni de tester « Approuver » et « Refuser » sur une
 * carte déjà traitée.
 *
 * Les dates sont relatives au chargement, comme dans le reste des fixtures :
 * une demande « créée il y a deux heures » doit le rester demain.
 */
export function demoAccessRequests(
  status?: string | null
): DemoAccessRequestRow[] {
  const now = Date.now();
  const minutesAgo = (minutes: number) =>
    new Date(now - minutes * 60_000).toISOString();

  const rows: DemoAccessRequestRow[] = [
    {
      id: "ar_demo_1",
      firstName: "Karim",
      lastName: "Benali",
      phone: "0661123456",
      email: "k.benali@email.com",
      role: "Syndic",
      message:
        "Bonjour, je suis le syndic de la résidence et je souhaite suivre les interventions sur l'ascenseur principal.",
      status: "PENDING",
      decidedAt: null,
      createdAt: minutesAgo(125),
      elevator: {
        id: "elv_demo_jasmins",
        elevatorCode: "ASC-2026-0001",
        building: {
          id: "bld_demo_jasmins",
          name: "Résidence Les Jasmins",
          city: "Alger",
        },
      },
      decidedBy: null,
      createdUser: null,
    },
    {
      id: "ar_demo_2",
      firstName: "Sarah",
      lastName: "Amrani",
      phone: "0550987654",
      email: "s.amrani@email.com",
      role: "Propriétaire",
      message:
        "Propriétaire de deux appartements dans la tour, je voudrais accéder au suivi de l'appareil.",
      status: "APPROVED",
      decidedAt: minutesAgo(26 * 60),
      createdAt: minutesAgo(50 * 60),
      elevator: {
        id: "elv_demo_kouba",
        elevatorCode: "ASC-2026-0004",
        building: {
          id: "bld_demo_kouba",
          name: "Tour Kouba",
          city: "Alger",
        },
      },
      decidedBy: { id: "usr_admin", name: "Dana Whitfield" },
      createdUser: {
        id: "usr_owner_demo",
        name: "Sarah Amrani",
        email: "s.amrani@email.com",
      },
    },
    /**
     * Un accès invité sur un site du « Syndic Les Pins ».
     *
     * L'onglet « Accès Portail Client » liste les comptes rattachés au parc ;
     * sans cette ligne, la fiche du syndic n'aurait que le titulaire et ne
     * montrerait pas qu'une demande QR approuvée crée bien un compte sur un
     * immeuble donné.
     */
    {
      id: "ar_demo_4",
      firstName: "Nadia",
      lastName: "Belkacem",
      phone: "0662389145",
      email: "n.belkacem@email.dz",
      role: "Propriétaire",
      message:
        "Propriétaire au 7e étage de la Tour El Hana, je souhaite suivre les interventions de l'ascenseur.",
      status: "APPROVED",
      decidedAt: minutesAgo(5 * 24 * 60),
      createdAt: minutesAgo(6 * 24 * 60),
      elevator: {
        id: "elv_demo_hana_1",
        elevatorCode: "HANA-01",
        building: {
          id: "bld_demo_hana",
          name: "Tour El Hana",
          city: "Alger",
        },
      },
      decidedBy: { id: "usr_admin", name: "Dana Whitfield" },
      createdUser: {
        id: "usr_demo_invite_1",
        name: "Nadia Belkacem",
        email: "n.belkacem@email.dz",
      },
    },
    {
      id: "ar_demo_3",
      firstName: "Yassine",
      lastName: "Kader",
      phone: "0770123456",
      email: "y.kader@email.com",
      role: "Gardien",
      message:
        "Je suis le gardien de la résidence et je signale les pannes au bureau.",
      status: "REJECTED",
      decidedAt: minutesAgo(3 * 24 * 60),
      createdAt: minutesAgo(4 * 24 * 60),
      elevator: {
        id: "elv_demo_bahdja",
        elevatorCode: "ASC-2026-0002",
        building: {
          id: "bld_demo_bahdja",
          name: "Résidence El Bahdja",
          city: "Blida",
        },
      },
      decidedBy: { id: "usr_admin", name: "Dana Whitfield" },
      createdUser: null,
    },
  ];

  const filtered = status
    ? rows.filter((row) => row.status === status)
    : rows.slice();

  const rank = (value: DemoAccessRequestRow["status"]) =>
    value === "PENDING" ? 0 : value === "APPROVED" ? 1 : 2;

  // Même ordre que la route : ce qui attend d'abord, puis par ancienneté.
  return filtered.sort(
    (a, b) =>
      rank(a.status) - rank(b.status) ||
      a.createdAt.localeCompare(b.createdAt)
  );
}

// ─── Couverture contractuelle ───────────────────────────────

interface DemoContractSeed {
  id: string;
  reference: string;
  tier: SLATier;
  status: ContractStatus;
  renewal: ContractRenewalMode;
  noticeDays: number;
  startMonthsAgo: number;
  endDaysFromNow: number;
  buildingIds: string[];
  responseHours: number;
  interventionHours: number;
}

/**
 * Trois contrats, pour que les trois couleurs se voient.
 *
 * Un contrat actif serein, un contrat qui entre dans le préavis (orange) et un
 * contrat suspendu (orange lui aussi, mais pour une autre raison) — sans quoi
 * la légende affirme des états que l'écran ne montre jamais. Les dates sont
 * relatives au jour : une fixture figée finirait par expirer et rendre le
 * badge vert d'un contrat pourtant échu.
 *
 * Les règles de calcul sont celles de `contracts/status.ts`, pas une copie :
 * `effectiveStatus`, `effectiveEndsAt` et `expiryAlert` sont les mêmes
 * fonctions que la route et les écrans lisent.
 */
export function demoCoverage(ownerId?: string | null): CoverageContract[] {
  const { buildings } = demoWorld();
  const now = new Date();

  const seeds: DemoContractSeed[] = [
    {
      id: "ct_demo_1",
      reference: "CT-2026-0001",
      tier: "PREMIUM",
      status: "ACTIVE",
      renewal: "AUTO",
      noticeDays: 60,
      startMonthsAgo: 10,
      endDaysFromNow: 120,
      buildingIds: ["bld_1"],
      responseHours: 4,
      interventionHours: 8,
    },
    {
      id: "ct_demo_2",
      reference: "CT-2026-0002",
      tier: "STANDARD",
      status: "ACTIVE",
      renewal: "MANUAL",
      noticeDays: 30,
      startMonthsAgo: 11,
      endDaysFromNow: 18,
      buildingIds: ["bld_2"],
      responseHours: 8,
      interventionHours: 24,
    },
    {
      id: "ct_demo_3",
      reference: "CT-2026-0003",
      tier: "BASIC",
      status: "SUSPENDED",
      renewal: "NONE",
      noticeDays: 30,
      startMonthsAgo: 6,
      endDaysFromNow: 200,
      buildingIds: ["bld_3"],
      responseHours: 24,
      interventionHours: 48,
    },
    /**
     * Le contrat du « Syndic Les Pins », qui couvre ses deux sites d'un seul
     * acte. Un client avec un parc sans contrat serait le cas que l'écran des
     * clients signale justement comme une anomalie — la fixture ne doit pas
     * montrer ce qu'elle dénonce.
     */
    {
      id: "ct_demo_4",
      reference: "CT-2026-0004",
      tier: "PREMIUM",
      status: "ACTIVE",
      renewal: "AUTO",
      noticeDays: 45,
      startMonthsAgo: 8,
      endDaysFromNow: 150,
      buildingIds: ["bld_demo_pins", "bld_demo_hana", "bld_demo_palmier"],
      responseHours: 4,
      interventionHours: 12,
    },
  ];

  const drafts = seeds.map((seed) => {
      const startsAt = new Date(now);
      startsAt.setMonth(startsAt.getMonth() - seed.startMonthsAgo);
      const endsAt = new Date(now);
      endsAt.setDate(endsAt.getDate() + seed.endDaysFromNow);

      const dated = {
        status: seed.status,
        renewalMode: seed.renewal,
        startsAt,
        endsAt,
      };

      const covered = seed.buildingIds
        .map((id) => buildings.find((building) => building.id === id))
        .filter((building): building is (typeof buildings)[number] =>
          Boolean(building)
        );

      return {
        contract: {
          id: seed.id,
          reference: seed.reference,
          slaTier: seed.tier,
          status: seed.status,
          effectiveStatus: effectiveStatus(dated, now),
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          effectiveEndsAt: effectiveEndsAt(dated, now).toISOString(),
          renewalMode: seed.renewal,
          noticeDays: seed.noticeDays,
          responseHours: seed.responseHours,
          interventionHours: seed.interventionHours,
          buildings: covered.map((building) => ({
            id: building.id,
            name: building.name,
            city: building.city,
          })),
          expiry: expiryAlert(dated, now),
        } satisfies CoverageContract,
        // Pivot local, jamais rendu : il sert uniquement au cloisonnement.
        ownerIds: covered.map((building) => building.ownerId),
      };
    });

  return drafts
    .filter((draft) => !ownerId || draft.ownerIds.includes(ownerId))
    .map((draft) => draft.contract)
    .sort((a, b) =>
      a.effectiveStatus === b.effectiveStatus
        ? a.reference.localeCompare(b.reference, "fr")
        : a.effectiveStatus === "ACTIVE"
          ? -1
          : 1
    );
}

// ─── Factures ───────────────────────────────────────────────

export interface DemoInvoiceRow {
  id: string;
  number: string;
  issuedAt: string;
  amount: string;
  currency: string;
  orderNumber: string;
  orderTitle: string;
  buildingName: string;
  clientId: string | null;
  clientName: string;
  workOrderId: string;
  status: InvoiceStatus;
  statusChangedAt: string | null;
}

export interface DemoInvoiceRegisterPayload {
  data: DemoInvoiceRow[];
  pagination: { total: number; page: number; limit: number; totalPages: number };
  clients: { id: string; name: string }[];
  totalAmount: string | null;
}

/**
 * Le registre des factures, dérivé des interventions terminées.
 *
 * POURQUOI DÉRIVÉES PLUTÔT QU'ÉCRITES UNE PAR UNE
 * Une facture est toujours la suite d'un bon terminé. Les écrire à la main
 * produirait des numéros de bon qui ne correspondent à rien, et la première
 * personne à cliquer sur une ligne tomberait sur un 404. Ici, chaque facture
 * pointe sur un `wo_*` réel de la fixture, sur son immeuble réel et sur le
 * client qui possède cet immeuble.
 *
 * Le montant vient de `WorkOrder.invoiceAmount` quand la fixture le porte —
 * une seule intervention est facturable dans le jeu de démonstration — et à
 * défaut d'un forfait déterministe calculé sur les heures. C'est un chiffre de
 * démonstration, pas un tarif : il n'est lu par aucune règle.
 */
export function demoInvoiceRegister(limit = 50): DemoInvoiceRegisterPayload {
  const { workOrders, elevators, buildings, users } = demoWorld();
  const now = new Date();

  const completed = workOrders
    .filter((order) => order.status === "COMPLETED")
    .sort((a, b) => {
      const aTime = a.completedAt?.getTime() ?? 0;
      const bTime = b.completedAt?.getTime() ?? 0;
      return bTime - aTime;
    });

  const rows: DemoInvoiceRow[] = completed.map((order, index) => {
    const unit = elevators.find((elevator) => elevator.id === order.elevatorId);
    const site = unit
      ? buildings.find((building) => building.id === unit.buildingId)
      : undefined;
    const owner = site?.ownerId
      ? users.find((user) => user.id === site.ownerId)
      : undefined;

    const issuedAt = order.completedAt
      ? new Date(order.completedAt.getTime() + 24 * 60 * 60 * 1000)
      : new Date(now.getTime() - (index + 1) * 24 * 60 * 60 * 1000);

    const amount =
      order.invoiceAmount != null
        ? order.invoiceAmount.toString()
        : String(
            Math.round(
              12_000 + (order.actualHours ?? order.estimatedHours ?? 2) * 4_500
            )
          );

    // Deux états seulement dans un jeu de démonstration : une facture émise
    // qu'on peut encore régler, et une facture déjà réglée. `CANCELLED`
    // reste absent — une facture annulée sans historique ne montre rien.
    const status: InvoiceStatus = index % 3 === 0 ? "PAID" : "ISSUED";

    return {
      id: `demo_invoice_${index + 1}`,
      number: `FA-${issuedAt.getUTCFullYear()}-${String(index + 1).padStart(
        4,
        "0"
      )}`,
      issuedAt: issuedAt.toISOString(),
      amount,
      currency: "DZD",
      orderNumber: order.orderNumber,
      orderTitle: order.title,
      buildingName: site?.name ?? "Immeuble non renseigné",
      clientId: owner?.id ?? null,
      clientName: owner?.name ?? "Client non renseigné",
      workOrderId: order.id,
      status,
      statusChangedAt:
        status === "PAID"
          ? new Date(issuedAt.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString()
          : null,
    };
  });

  const clients = Array.from(
    new Map(
      rows
        .filter(
          (row): row is DemoInvoiceRow & { clientId: string } =>
            row.clientId !== null
        )
        .map((row) => [row.clientId, { id: row.clientId, name: row.clientName }])
    ).values()
  ).sort((a, b) => a.name.localeCompare(b.name, "fr"));

  const page = rows.slice(0, limit);
  const totalAmount = rows.reduce((sum, row) => sum + Number(row.amount), 0);

  return {
    data: page,
    pagination: {
      total: rows.length,
      page: 1,
      limit,
      totalPages: Math.max(1, Math.ceil(rows.length / Math.max(limit, 1))),
    },
    clients,
    totalAmount: Number.isFinite(totalAmount) ? String(totalAmount) : null,
  };
}
