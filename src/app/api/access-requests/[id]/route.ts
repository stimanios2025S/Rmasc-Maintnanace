/**
 * La décision du bureau sur une demande d'accès déposée depuis un QR.
 *
 * PATCH /api/access-requests/[id]   { action: "APPROVE" | "REJECT" }
 *
 * POURQUOI UNE SEULE ROUTE POUR LES DEUX GESTES
 * Approuver et refuser sont la même décision à deux issues, prise au même
 * endroit, par la même personne, sur la même ligne. Deux routes auraient
 * dupliqué la lecture de la demande, le contrôle « déjà décidée » et l'écriture
 * du verdict — et c'est exactement le genre de duplication où l'une des deux
 * finit par oublier le contrôle.
 *
 * CE QUE L'APPROBATION FAIT, DANS CET ORDRE
 *  1. Elle crée le compte client — rôle BUILDING_OWNER imposé par le serveur,
 *     jamais lu dans la requête : une route d'administration qui accepterait un
 *     rôle serait une route d'escalade de privilèges.
 *  2. Elle rattache l'immeuble de l'appareil scanné, si cet immeuble n'a pas
 *     déjà de propriétaire. Un immeuble déjà rattaché n'est pas transféré en
 *     silence : la réponse le dit, et la fiche client permet de le faire.
 *  3. Elle marque la demande APPROVED, avec son auteur et son compte créé.
 *  4. Elle envoie l'invitation — après le commit, et jamais de façon bloquante.
 *
 * Le mot de passe est engendré ici, haché, et renvoyé en clair une seule fois.
 * Il n'est stocké nulle part, comme pour toute ouverture de compte.
 */

import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  conflict,
  handleRouteError,
  jsonOk,
  notFound,
  readJson,
} from "@/lib/api/http";
import { requireRole } from "@/lib/api/guard";
import { generatePassword } from "@/lib/auth/passwords";
import { deliverInvitation } from "@/lib/notifications/invitation";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoAccessRequests } from "@/lib/demo/registers";

/** Le même facteur que la route des comptes clients, pour des hachages interchangeables. */
const BCRYPT_ROUNDS = 12;

const DecisionSchema = z
  .object({
    action: z.enum(["APPROVE", "REJECT"], {
      errorMap: () => ({
        message: "Action attendue : « APPROVE » ou « REJECT »",
      }),
    }),
  })
  .strict();

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  /**
   * La décision validée, gardée pour le repli de démonstration.
   *
   * Sans elle, le `catch` ne saurait pas si l'échec vient d'une base absente
   * avant ou après la validation du corps — et acquitter une requête malformée
   * serait pire que de la refuser.
   */
  let decision: { action: "APPROVE" | "REJECT" } | null = null;

  try {
    const session = await requireRole("ADMIN");
    const body = DecisionSchema.parse(await readJson(request));
    decision = body;

    const accessRequest = await prisma.accessRequest.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        role: true,
        status: true,
        elevator: {
          select: {
            elevatorCode: true,
            building: {
              select: { id: true, name: true, ownerId: true, isActive: true },
            },
          },
        },
      },
    });
    if (!accessRequest) {
      throw notFound(`Demande introuvable : ${params.id}`);
    }
    if (accessRequest.status !== "PENDING") {
      throw conflict(
        `Cette demande a déjà été traitée (${accessRequest.status}).`
      );
    }

    if (body.action === "REJECT") {
      const rejected = await prisma.accessRequest.update({
        where: { id: accessRequest.id },
        data: {
          status: "REJECTED",
          decidedAt: new Date(),
          decidedById: session.user.id,
        },
        select: { id: true, status: true, decidedAt: true },
      });
      return jsonOk({ request: rejected, client: null, password: null });
    }

    /**
     * Le compte ne peut pas être ouvert sur une adresse déjà prise : le
     * hachage posé sur la ligne existante ne doit jamais être écrasé, et
     * fusionner deux personnes dans un compte est une décision, pas une
     * conséquence.
     */
    const existing = await prisma.user.findUnique({
      where: { email: accessRequest.email },
      select: { id: true, role: true },
    });
    if (existing) {
      throw conflict(
        `Un compte utilise déjà l'adresse ${accessRequest.email}. ` +
          "Refusez la demande, ou corrigez l'adresse avant d'approuver."
      );
    }

    // Haché avant la transaction : bcrypt à 12 tours immobiliserait une
    // connexion pendant plusieurs centaines de millisecondes pour rien.
    const password = generatePassword();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const name =
      `${accessRequest.firstName} ${accessRequest.lastName}`.trim();

    const result = await prisma.$transaction(async (tx) => {
      /**
       * La demande est réclamée avant que le compte ne soit créé.
       *
       * Deux approbations simultanées — un double clic, deux onglets — liraient
       * toutes deux PENDING et ouvriraient deux comptes. La condition sur
       * `status` est réévaluée par PostgreSQL après l'attente du verrou : la
       * seconde écriture ne trouve plus rien à modifier et échoue proprement.
       */
      const claim = await tx.accessRequest.updateMany({
        where: { id: accessRequest.id, status: "PENDING" },
        data: {
          status: "APPROVED",
          decidedAt: new Date(),
          decidedById: session.user.id,
        },
      });
      if (claim.count !== 1) {
        throw conflict("Cette demande vient d'être traitée par une autre requête.");
      }

      const client = await tx.user.create({
        data: {
          name,
          email: accessRequest.email,
          passwordHash,
          phone: accessRequest.phone.length > 0 ? accessRequest.phone : null,
          // Imposé ici, et pas lu dans le corps : cette route ouvre des comptes
          // *clients*, jamais des comptes de salariés.
          role: "BUILDING_OWNER",
          clientType: "CONTRACTED",
          isActive: true,
        },
        select: { id: true, name: true, email: true, phone: true },
      });

      // L'immeuble de l'appareil scanné. Déjà rattaché à quelqu'un : on ne le
      // prend pas à son propriétaire — un scan ne transfère pas un portefeuille.
      const attachBuilding =
        accessRequest.elevator.building.isActive &&
        accessRequest.elevator.building.ownerId === null;

      if (attachBuilding) {
        await tx.building.update({
          where: { id: accessRequest.elevator.building.id },
          data: { ownerId: client.id },
        });
      }

      const decided = await tx.accessRequest.update({
        where: { id: accessRequest.id },
        data: {
          // Déjà APPROVED par la réclamation ci-dessus ; cette écriture ajoute
          // le compte engendré, qui n'existait pas encore.
          createdUserId: client.id,
        },
        select: { id: true, status: true, decidedAt: true },
      });

      return { client, decided, attachBuilding };
    });

    /**
     * L'invitation part après le commit. Elle ne peut pas défaire le compte,
     * et son échec n'est pas une erreur de la requête — l'écran affiche le mot
     * de passe et le bureau le transmet autrement si besoin.
     */
    const base = (process.env.NEXTAUTH_URL ?? "http://localhost:3000").replace(
      /\/+$/,
      ""
    );
    const invitation = await deliverInvitation({
      name,
      email: accessRequest.email,
      phone: accessRequest.phone,
      password,
      buildingName: accessRequest.elevator.building.name,
      elevatorCode: accessRequest.elevator.elevatorCode,
      declaredRole: accessRequest.role,
      signInUrl: `${base}/connexion`,
    });

    return jsonOk({
      request: result.decided,
      client: result.client,
      /** En clair, une seule fois. Haché en base, jamais relisible. */
      password,
      buildingAttached: result.attachBuilding,
      buildingName: accessRequest.elevator.building.name,
      invitation: {
        text: invitation.text,
        mailto: invitation.mailto,
        whatsapp: invitation.whatsapp,
      },
    });
  } catch (error) {
    /**
     * Mode démonstration : la décision est acquittée, pas enregistrée.
     *
     * Aucun compte n'est créé — le mot de passe serait celui d'un utilisateur
     * qui n'existe pas. La page le détecte par `demo: true` et affiche son
     * propre message ; elle ne montre pas le panneau d'identifiants.
     *
     * Le repli accepte aussi une demande déjà traitée : c'est ce qui permet de
     * tester « Approuver » et « Refuser » sur les trois cartes de la fixture,
     * ce qu'une démonstration limitée aux demandes en attente ne permettrait
     * pas.
     */
    if (decision && shouldServeDemoData(error)) {
      warnDemoFallbackOnce("PATCH /api/access-requests/[id]");
      const demo = demoAccessRequests().find((row) => row.id === params.id);
      const approved = decision.action === "APPROVE";

      return NextResponse.json({
        data: {
          request: {
            id: params.id,
            status: approved ? "APPROVED" : "REJECTED",
            decidedAt: new Date().toISOString(),
          },
          client: null,
          password: null,
          buildingAttached: false,
          buildingName: demo?.elevator.building.name ?? "",
          invitation: null,
        },
        demo: true,
      });
    }
    return handleRouteError(error);
  }
}
