/**
 * Maintenance RMASC – Canal dispatch ↔ terrain d'un bon de travail.
 *
 * GET  /api/work-orders/:id/messages – le fil, dans l'ordre chronologique
 * POST /api/work-orders/:id/messages – écrire un message horodaté
 *
 * QUI PARLE
 * L'équipe (ADMIN / responsable) et le technicien affecté à ce bon, personne
 * d'autre. Un technicien qui n'a pas le bon reçoit un 403 : le fil contient des
 * consignes d'intervention et parfois l'accès au site, ce n'est pas une lecture
 * de flotte. Un compte client n'y a pas accès du tout.
 *
 * CE QUE CE N'EST PAS
 * Ni un journal d'audit (les corrections du bureau vivent dans
 * `WorkOrderRevision`), ni le champ `notes` du bon : `notes` est l'état courant
 * et se réécrit, un message est un fait daté qui ne se réécrit pas.
 */

import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  forbidden,
  handleRouteError,
  notFound,
  readJson,
} from "@/lib/api/http";
import { MANAGEMENT_ROLES, OPS_ROLES, requireRole } from "@/lib/api/guard";
import type { Session } from "next-auth";
import { notify, notifyRoles } from "@/lib/notifications/service";

export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

const PostSchema = z
  .object({
    content: z.string().trim().min(1, "Le message est vide").max(2000),
  })
  .strict();

const MESSAGE_SELECT = {
  id: true,
  content: true,
  createdAt: true,
  sender: { select: { id: true, name: true, role: true } },
} satisfies Prisma.WorkOrderMessageSelect;

interface OrderForThread {
  id: string;
  orderNumber: string;
  assignedToId: string | null;
  elevator: { elevatorCode: string };
}

async function loadOrder(id: string): Promise<OrderForThread> {
  const order = await prisma.workOrder.findUnique({
    where: { id },
    select: {
      id: true,
      orderNumber: true,
      assignedToId: true,
      elevator: { select: { elevatorCode: true } },
    },
  });
  if (!order) throw notFound(`Bon de travail introuvable : ${id}`);
  return order;
}

/**
 * Le cloisonnement du fil : l'équipe, ou le technicien à qui le bon est
 * affecté. Il est appliqué en lecture comme en écriture.
 */
function assertCanUseThread(session: Session, order: OrderForThread): void {
  if (session.user.role === "FIELD_TECHNICIAN") {
    if (order.assignedToId !== session.user.id) {
      throw forbidden("Ce bon de travail ne vous est pas affecté.");
    }
  }
}

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireRole(...OPS_ROLES);
    const order = await loadOrder(params.id);
    assertCanUseThread(session, order);

    const messages = await prisma.workOrderMessage.findMany({
      where: { workOrderId: order.id },
      orderBy: { createdAt: "asc" },
      take: 200,
      select: MESSAGE_SELECT,
    });

    return NextResponse.json({ data: messages });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireRole(...OPS_ROLES);
    const order = await loadOrder(params.id);
    assertCanUseThread(session, order);

    const body = PostSchema.parse(await readJson(request));

    const message = await prisma.workOrderMessage.create({
      data: {
        workOrderId: order.id,
        senderId: session.user.id,
        content: body.content,
      },
      select: MESSAGE_SELECT,
    });

    const preview =
      body.content.length > 160
        ? `${body.content.slice(0, 157)}…`
        : body.content;

    /**
     * Prévenir l'autre côté. `notify` / `notifyRoles` ne lèvent jamais : un
     * message enregistré ne doit pas être perdu parce qu'une notification a
     * échoué.
     */
    if (session.user.role === "FIELD_TECHNICIAN") {
      await notifyRoles([...MANAGEMENT_ROLES], {
        title: `Message terrain — ${order.orderNumber}`,
        message: `${session.user.name ?? "Technicien"} : ${preview}`,
        type: "DISPATCH",
        linkUrl: `/bons-de-travail/${order.id}`,
        workOrderId: order.id,
      });
    } else if (order.assignedToId) {
      await notify({
        userId: order.assignedToId,
        title: `Message du bureau — ${order.orderNumber}`,
        message: preview,
        type: "DISPATCH",
        linkUrl: "/technicien",
        workOrderId: order.id,
      });
    }

    return NextResponse.json({ data: message }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
