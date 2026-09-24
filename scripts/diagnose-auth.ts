/**
 * ElevatorPulse – Auth diagnostics & demo password reset
 *
 * Run this when login says "Invalid email or password":
 *
 *   npx tsx scripts/diagnose-auth.ts        # check only
 *   npx tsx scripts/diagnose-auth.ts --fix  # reset demo passwords to password123
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const DEMO_PASSWORD = "password123";
const DEMO_EMAILS = [
  "admin@elevatorpulse.com",
  "manager@elevatorpulse.com",
  "tech1@elevatorpulse.com",
  "tech2@elevatorpulse.com",
  "owner@metroplaza.com",
];

async function main() {
  const fix = process.argv.includes("--fix");
  const prisma = new PrismaClient();

  try {
    await prisma.$connect();
    console.log("✅ Database connection OK\n");

    const users = await prisma.user.findMany({
      select: {
        email: true,
        name: true,
        role: true,
        isActive: true,
        passwordHash: true,
      },
      orderBy: { email: "asc" },
    });

    console.log(`Users in database: ${users.length}`);
    if (users.length === 0) {
      console.log("❌ No users found at all. Run:  npm run db:seed\n");
    }

    let bad = users.length === 0 ? 1 : 0;
    for (const email of DEMO_EMAILS) {
      const u = users.find((x) => x.email === email);
      if (!u) {
        console.log(`❌ ${email} — MISSING (run npm run db:seed)`);
        bad++;
        continue;
      }
      const active = u.isActive ? "active" : "DISABLED";
      const ok = await bcrypt.compare(DEMO_PASSWORD, u.passwordHash);
      console.log(
        `${ok ? "✅" : "❌"} ${email} — ${u.role}, ${active}, "password123" ${
          ok ? "works" : "DOES NOT MATCH stored hash"
        }`
      );
      if (!ok) {
        bad++;
        if (fix) {
          const hash = await bcrypt.hash(DEMO_PASSWORD, 12);
          await prisma.user.update({
            where: { email },
            data: { passwordHash: hash, isActive: true },
          });
          console.log(`   🔧 password reset + account enabled for ${email}`);
        }
      }
    }

    if (bad === 0) {
      console.log(
        "\n🎉 All demo logins should work. If login still fails, restart `npm run dev` and watch the server terminal while signing in."
      );
    } else if (!fix) {
      console.log(
        "\nRun with --fix to reset demo passwords:\n  npx tsx scripts/diagnose-auth.ts --fix"
      );
    }
  } catch (e) {
    console.error("\n❌ Could not reach the database.");
    console.error("   1) Is PostgreSQL running?");
    console.error("   2) Is DATABASE_URL correct in .env?");
    console.error(
      "   3) Did you run:  npx prisma generate && npx prisma db push ?"
    );
    console.error(`\n   Details: ${(e as Error).message}\n`);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
