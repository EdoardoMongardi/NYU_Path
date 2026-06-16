// ============================================================
// E6.2 — guard: the `db:migrate` deploy step exists + applies
// ============================================================
// drizzle-kit is an unscripted devDep; before E6.2 the only scripts
// in apps/web/package.json were dev/build/start, so an operator had no
// documented way to APPLY migrations against a live Neon DB. E6.2 adds
// a `db:migrate` script that resolves to drizzle-kit's APPLY command
// (`drizzle-kit migrate`) — NOT `generate`/`push`/`up`, which do not
// apply the journaled SQL files in sequence.
//
// This guard pins:
//   • the script exists and runs the real apply command (drizzle-kit
//     migrate), so a deploy/runbook step can call it;
//   • it is the apply command, not generate/push;
//   • the pre-existing dev/build/start scripts are untouched.
// ============================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("db:migrate deploy script (E6.2)", () => {
    const pkg = JSON.parse(
        readFileSync(join(__dirname, "../package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    it("defines a db:migrate script", () => {
        expect(pkg.scripts).toBeDefined();
        expect(pkg.scripts?.["db:migrate"]).toBeTypeOf("string");
    });

    it("the db:migrate script runs the drizzle-kit APPLY command (migrate)", () => {
        const script = pkg.scripts?.["db:migrate"] ?? "";
        expect(script).toContain("drizzle-kit");
        expect(script).toContain("migrate");
        // It must be the apply command, NOT generate/push — those do not
        // apply the journaled SQL files against the live DB.
        expect(script).not.toContain("generate");
        expect(script).not.toContain("push");
    });

    it("does not regress the pre-existing dev/build/start scripts", () => {
        expect(pkg.scripts?.dev).toBe("next dev --webpack");
        expect(pkg.scripts?.build).toBe("next build");
        expect(pkg.scripts?.start).toBe("next start");
    });
});
