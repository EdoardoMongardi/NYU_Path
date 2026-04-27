// ============================================================
// Phase 6 WS3 — legacy-deprecation regression guard
// ============================================================
// Pins the set of callers that still import the deprecated modules
// (`chat/*`, `data/academicRules.ts`, `search/semanticSearch.ts`).
// New callers must be migrated to the agent loop instead — adding one
// here without removing it from the grandfathered list will fail the
// guard test.
// ============================================================

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

/** Files allowed to import the deprecated modules. Removing one of
 *  these grandfathered entries means the file has been migrated to
 *  the agent loop and the deprecation can advance. */
const GRANDFATHERED_CALLERS = new Set([
    // Production web route — migrates in Phase 6.1 WS2.
    "apps/web/app/api/chat/route.ts",
    // Eval helpers (not on the user-facing path).
    "packages/engine/tests/eval/evaluation_script.ts",
    "packages/engine/tests/eval/types.ts",
    "packages/engine/tests/eval/types.d.ts",
    "packages/engine/tests/eval/advisoryQuality.ts",
    // Developer utility script.
    "scripts/test-search.ts",
    // Internal cross-references inside the deprecated tree itself
    // (chat/* → chat/*, academicRules → chat/*).
    "packages/engine/src/chat/chatOrchestrator.ts",
    "packages/engine/src/chat/explanationGenerator.ts",
]);

const DEPRECATED_IMPORT = /from\s+["'](?:@nyupath\/engine\/chat\/|[^"']*\/chat\/(?:chatOrchestrator|intentRouter|explanationGenerator|llmClient|onboardingFlow)|[^"']*\/data\/academicRules|[^"']*\/search\/semanticSearch)/;

const SCAN_ROOTS = ["apps", "packages", "scripts", "evals"];

const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".turbo", ".vite"]);

function* walkTs(dir: string): Generator<string> {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        let s;
        try { s = statSync(full); } catch { continue; }
        if (s.isDirectory()) {
            yield* walkTs(full);
        } else if (s.isFile() && /\.(ts|tsx)$/.test(name)) {
            yield full;
        }
    }
}

describe("WS3 legacy-deprecation guard", () => {
    it("no NEW callers of legacy chat/, academicRules, semanticSearch outside the grandfathered set", () => {
        const callers: string[] = [];
        for (const root of SCAN_ROOTS) {
            for (const file of walkTs(join(REPO_ROOT, root))) {
                const rel = relative(REPO_ROOT, file);
                // Skip the deprecated files themselves — their internal
                // cross-references vanish when the tree is removed.
                if (rel.startsWith("packages/engine/src/chat/")) continue;
                if (rel === "packages/engine/src/data/academicRules.ts") continue;
                if (rel === "packages/engine/src/search/semanticSearch.ts") continue;

                let content: string;
                try { content = readFileSync(file, "utf-8"); } catch { continue; }
                if (DEPRECATED_IMPORT.test(content)) callers.push(rel);
            }
        }
        const unexpected = callers.filter((c) => !GRANDFATHERED_CALLERS.has(c));
        expect(
            unexpected,
            `New legacy callers detected: ${unexpected.join(", ")}. Migrate to runAgentTurn + the §7.2 tool registry.`,
        ).toEqual([]);
    });

    it("every grandfathered caller still actually exists (catches accidental orphans)", () => {
        for (const c of GRANDFATHERED_CALLERS) {
            const full = join(REPO_ROOT, c);
            // statSync throws if missing — we want a clear failure.
            expect(() => statSync(full), `grandfathered caller "${c}" no longer exists; remove it from the list`).not.toThrow();
        }
    });
});
