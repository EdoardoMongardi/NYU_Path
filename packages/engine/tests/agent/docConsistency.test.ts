// ============================================================
// docConsistency.test.ts — cross-doc reference-drift guard (Layer 1)
// ============================================================
// The recurring failure mode: a fact (tool count, axis count) is echoed across
// many LIVING docs, and when it changes only the "home" doc gets updated — the
// echoes go stale (e.g. the FOSE 24→22 drop left "20/21 tools" in README /
// 00-overview / Docs/README). This test derives each fact from CODE and asserts
// every claim of it in the living docs matches.
//
// SCOPE — living docs only. Point-in-time records (Docs/plans, audits, reports,
// deprecated, specs, mockups, reference) are DELIBERATELY frozen: a June plan
// that says "24 tools" is correct history and must NOT be retro-edited, so they
// are excluded here. See Docs/README.md "Living vs point-in-time".
//
// Intentional non-current mentions INSIDE a living doc (e.g. 00-overview's
// "started with 7 axes … gained an 8th") are listed in ALLOW.
// ============================================================

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildDefaultRegistry } from "../../src/agent/registry.js";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

// ── canonical facts, derived from code (never hard-coded) ──────────────────
const liveToolCount = buildDefaultRegistry().list().length;

const validatorAxisCount = (() => {
    const src = readFileSync(
        join(REPO_ROOT, "packages/engine/src/agent/forwardSchedule/graduationPathValidator.ts"),
        "utf8",
    );
    const union = src.match(/export type ValidatorAxis\s*=([\s\S]*?);/);
    if (!union) throw new Error("ValidatorAxis union not found");
    return [...union[1].matchAll(/"[a-zA-Z]+"/g)].length;
})();

// ── the living-doc set (kept current; must agree with code) ────────────────
function currentSystemDocs(): string[] {
    const root = join(REPO_ROOT, "Docs", "current-system");
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            if (statSync(full).isDirectory()) walk(full);
            else if (name.endsWith(".md")) out.push(full.slice(REPO_ROOT.length + 1).split("\\").join("/"));
        }
    };
    walk(root);
    return out;
}

const LIVING_DOCS = [
    "CLAUDE.md",
    "README.md",
    "Docs/README.md",
    "Docs/STATUS.md",
    "Docs/FROZEN.md",
    "Docs/GLOSSARY.md",
    "Docs/core_philosophy.md",
    "Docs/index.json",
    ...currentSystemDocs(),
];

// ── the facts to check + the claim patterns (capture group 1 = the number) ─
const FACTS = [
    {
        name: "live tool count",
        value: liveToolCount,
        patterns: [
            // "22 tools" / "22 live tools" / "22 registered tools" — but NOT a plan/phase
            // number ("Plan 37 tool", "Phase-15 tool") and NOT a different kind of count
            // ("tool modules/messages/calls/enhancements/definitions").
            /(?<!Phase[-\s])(?<!Plan\s)\b(\d+)\s+(?:live\s+|registered\s+)?tools?\b(?!\s+(?:module|message|call|enhancement|definition|def))/gi,
            /\b(\d+)\s+specialists?\b/gi,
            /\b(\d+)\s+deterministic\s+functions?\b/gi,
        ],
    },
    {
        name: "validator axis count",
        value: validatorAxisCount,
        patterns: [/\b(\d+)[-\s]ax(?:is|es)\b/gi],
    },
];

// ── intentional non-current mentions inside a living doc (file :: matched text) ─
// These describe the pre-8th-axis HISTORY or a SUBSET, not the current total.
const ALLOW = new Set<string>([
    "Docs/current-system/00-overview.md::7 axes",                      // "started with 7 axes … gained an 8th"
    "Docs/current-system/engine/forward-schedule.md::7-axis",         // "formerly-frozen 7-axis contract"
    "Docs/current-system/web/ui-components.md::7-axis",               // "formerly-frozen 7-axis contract"
    "Docs/current-system/web/plan-action-routes.md::7-axis",          // "the frozen 7-axis + 8th P/F-limit axis"
    "Docs/current-system/engine/tool-envelope.md::7 registered tools", // envelope-opting SUBSET, not the registry total
]);

function lineOf(content: string, index: number): number {
    return content.slice(0, index).split("\n").length;
}

describe("cross-doc consistency — living docs agree with code on load-bearing counts", () => {
    it("has plausible canonical values derived from code", () => {
        expect(liveToolCount).toBeGreaterThan(0);
        expect(validatorAxisCount).toBeGreaterThan(0);
    });

    for (const fact of FACTS) {
        it(`every living-doc claim of the ${fact.name} equals ${fact.value}`, () => {
            const violations: string[] = [];
            for (const rel of LIVING_DOCS) {
                const content = readFileSync(join(REPO_ROOT, rel), "utf8");
                for (const pattern of fact.patterns) {
                    for (const m of content.matchAll(pattern)) {
                        const claimed = Number(m[1]);
                        if (claimed === fact.value) continue;
                        if (ALLOW.has(`${rel}::${m[0].trim()}`)) continue;
                        violations.push(
                            `${rel}:${lineOf(content, m.index ?? 0)} — "${m[0].trim()}" claims ${claimed}, expected ${fact.value}`,
                        );
                    }
                }
            }
            expect(violations, `\nStale ${fact.name} references (fix the doc, or add to ALLOW if intentionally historical):\n${violations.join("\n")}\n`).toEqual([]);
        });
    }
});
