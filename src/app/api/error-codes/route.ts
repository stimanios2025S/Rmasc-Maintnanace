/**
 * ElevatorPulse – Error Code Lookup API
 *
 * GET /api/error-codes?q=E-101&limit=20 – search the fault-code reference
 *
 * Readable by every authenticated role including BUILDING_OWNER: this is the
 * lookup behind the client portal's troubleshooting wizard, and the customer
 * is the primary intended reader. Nothing here is tenant-specific — the codes
 * describe the equipment, not who owns it — so unlike the fleet endpoints
 * there is no portfolio scope to apply. That is a deliberate exception to the
 * `buildingScopeFor` rule in `src/lib/api/guard.ts`, not an oversight.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { handleRouteError, parsePagination } from "@/lib/api/http";
import { OPS_ROLES, requireRole } from "@/lib/api/guard";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoErrorCodes } from "@/lib/demo/responses";
import { presentErrorCode } from "@/lib/incidents/error-codes";
import type { Prisma } from "@prisma/client";

const QuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
});

export async function GET(request: NextRequest) {
  try {
    await requireRole(...OPS_ROLES, "BUILDING_OWNER");

    const { q } = QuerySchema.parse({
      q: request.nextUrl.searchParams.get("q") ?? undefined,
    });
    const { limit } = parsePagination(request.nextUrl.searchParams, {
      defaultLimit: 50,
      maxLimit: 200,
    });

    const where: Prisma.ErrorCodeWhereInput = {
      isActive: true,
      ...(q
        ? {
            OR: [
              // Exact code first so typing a complete code returns it ahead of
              // every other code that merely contains the same digits. The
              // ordering is applied below rather than relying on the OR.
              { code: { equals: q, mode: "insensitive" as const } },
              { code: { contains: q, mode: "insensitive" as const } },
              { title: { contains: q, mode: "insensitive" as const } },
              { description: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    const rows = await prisma.errorCode.findMany({
      where,
      orderBy: { code: "asc" },
      take: limit,
      select: {
        id: true,
        code: true,
        title: true,
        description: true,
        solution: true,
        audioUrl: true,
      },
    });

    const presented = rows.map(presentErrorCode);

    if (q) {
      const needle = q.toLowerCase();
      presented.sort((a, b) => {
        const aExact = a.code.toLowerCase() === needle ? 0 : 1;
        const bExact = b.code.toLowerCase() === needle ? 0 : 1;
        return aExact - bExact;
      });
    }

    return NextResponse.json({ data: presented });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/error-codes");
      return NextResponse.json({
        data: demoErrorCodes(request.nextUrl.searchParams.get("q")),
      });
    }
    return handleRouteError(error);
  }
}
