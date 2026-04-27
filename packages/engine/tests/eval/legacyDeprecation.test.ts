// ============================================================
// Phase 6 WS3 — legacy-deprecation regression guard (post-cutover)
// ============================================================
// Phase 6.5 P-2 deleted the deprecated modules (`chat/chatOrchestrator`,
// `chat/intentRouter`, `chat/explanationGenerator`, `chat/llmClient`,
// `chat/onboardingFlow`, `data/academicRules.ts`,
// `search/semanticSearch.ts`) and their dependent eval helpers. This
// test now guards against accidental REINTRODUCTION: any new caller
// importing from those paths fails CI.
//
// `chat/transcriptParser.ts` STAYS — it parses PDFs for the
// onboarding route and is unrelated to the agent loop.
// ============================================================

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

/** Empty post-cutover. Any import that matches DEPRECATED_IMPORT
 *  must be migrated to the agent loop — there are no legitimate
 *  legacy callers anymore. */
const GRANDFATHERED_CALLERS = new Set<string>();

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
