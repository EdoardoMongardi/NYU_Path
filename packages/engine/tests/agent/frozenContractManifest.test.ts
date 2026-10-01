// ============================================================
// frozenContractManifest.test.ts — executable guards for Docs/FROZEN.md
// ============================================================
// Docs/FROZEN.md names the never-change engine seam + the validity
// definition in PROSE. Prose does not fail a build. This file turns three
// of those invariants into tests that DO:
//
//   1. FROZEN §1/§3 — the schedule seam (`solveForwardSchedule` /
//      `finalizeForwardSchedule`) is INVOKED only from the enumerated
//      call-site files. A new schedule path that bypasses the seam adds a
//      file here and fails.
//   2. FROZEN §2 / plan-39 B3 — validity is defined by EXACTLY 8 validator
//      axes. Renaming/adding/dropping one changes the `ValidatorAxis` union
//      and fails (no single "all-8-axes" test existed before — the gap
//      FROZEN §2 flags).
//   3. The live tool registry stays at 22 with the two FOSE tools OFF, and
//      the per-tool docs stay 1:1 with the registry.
//
// These allowlists ARE the manifest. Changing one is a deliberate,
// owner-reviewed architecture decision (FROZEN.md: "escalate to the owner
// and state the trade-off") — update the allowlist AND FROZEN.md together.
// Guard style mirrors the existing tests/eval/legacyDeprecation.test.ts.
// ============================================================

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildDefaultRegistry } from "../../src/agent/registry.js";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const ENGINE_SRC = join(REPO_ROOT, "packages", "engine", "src");
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".turbo", ".vite"]);

function* walkTs(dir: string): Generator<string> {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        let s;
        try { s = statSync(full); } catch { continue; }
        if (s.isDirectory()) yield* walkTs(full);
        else if (name.endsWith(".ts")) yield full;
    }
}

/** Drop `//` and `/* *\/`/JSDoc lines so a symbol named only in prose
 *  (e.g. forwardSchedule/types.ts: "…what solveForwardSchedule() returns")
 *  is NOT counted as an invocation. */
function codeOnly(src: string): string {
    const out: string[] = [];
    let inBlock = false;
    for (const raw of src.split("\n")) {
        const line = raw.trim();
        if (inBlock) {
            if (line.includes("*/")) inBlock = false;
            continue;
        }
        if (line.startsWith("/*")) {
            if (!line.includes("*/")) inBlock = true;
            continue;
        }
        if (line.startsWith("//") || line.startsWith("*")) continue;
        out.push(raw.replace(/\/\/.*$/, ""));
    }
    return out.join("\n");
}

/** Repo-relative paths of engine/src files that INVOKE `symbol(` (the
 *  definition file matches too — `export function symbol(` — which is
 *  intended: the def is a legitimate member of the seam). */
function filesInvoking(symbol: string): string[] {
    const re = new RegExp(`\\b${symbol}\\s*\\(`);
    const hits: string[] = [];
    for (const f of walkTs(ENGINE_SRC)) {
        if (re.test(codeOnly(readFileSync(f, "utf8")))) {
            hits.push(f.slice(REPO_ROOT.length + 1).split("\\").join("/"));
        }
    }
    return hits.sort();
}

describe("FROZEN §1/§3 — the schedule seam is invoked only at the enumerated call sites", () => {
    // FROZEN.md §1 (finalizeForwardSchedule) + §3 (solveForwardSchedule).
    // A new engine path that builds a schedule MUST route through the seam;
    // if it calls either symbol directly it appears here and this fails —
    // the deliberate checkpoint before forking the frozen pipeline.
    const FINALIZE_CALL_SITES = [
        "packages/engine/src/agent/forwardSchedule/alternatives.ts",
        "packages/engine/src/agent/forwardSchedule/build.ts", // defines + calls
        "packages/engine/src/agent/forwardSchedule/whatIfAssumption.ts",
        "packages/engine/src/agent/sectionMaterialization/sectionReplanBridge.ts",
        "packages/engine/src/agent/tools/confirmPlanChange.ts",
        "packages/engine/src/agent/tools/proposePlanChange.ts",
    ].sort();

    const SOLVE_CALL_SITES = [
        "packages/engine/src/agent/forwardSchedule/alternatives.ts",
        "packages/engine/src/agent/forwardSchedule/build.ts",
        "packages/engine/src/agent/forwardSchedule/solver.ts", // defines
        "packages/engine/src/agent/forwardSchedule/whatIfAssumption.ts",
        "packages/engine/src/agent/sectionMaterialization/sectionReplanBridge.ts",
        "packages/engine/src/agent/tools/confirmPlanChange.ts",
        "packages/engine/src/agent/tools/proposePlanChange.ts",
    ].sort();

    it("finalizeForwardSchedule is called only from the manifest files", () => {
        expect(filesInvoking("finalizeForwardSchedule")).toEqual(FINALIZE_CALL_SITES);
    });

    it("solveForwardSchedule is called only from the manifest files", () => {
        expect(filesInvoking("solveForwardSchedule")).toEqual(SOLVE_CALL_SITES);
    });
});

describe("FROZEN §2 / plan-39 B3 — validity is exactly the 8 validator axes", () => {
    // graduationPathValidator.ts is FROZEN, so it cannot be edited to export a
    // runtime axis list; we pin the `ValidatorAxis` union at the source. The
    // result's `axisResults: Record<ValidatorAxis, …>` is TS-forced to cover
    // this union, so pinning the union pins the full check set.
    const EXPECTED_AXES = [
        "requirementGroupsSatisfied",
        "poolSlotsResolvable",
        "totalCreditsMeetMinimum",
        "thresholdsMet",
        "visaAxesPass",
        "assumptionsExplicit",
        "graduationTargetMet",
        "passFailLimitsRespected",
    ].sort();

    it("the ValidatorAxis union is exactly these 8 names", () => {
        const src = readFileSync(
            join(ENGINE_SRC, "agent", "forwardSchedule", "graduationPathValidator.ts"),
            "utf8",
        );
        const union = src.match(/export type ValidatorAxis\s*=([\s\S]*?);/);
        expect(union, "ValidatorAxis union not found").not.toBeNull();
        const axes = [...union![1].matchAll(/"([a-zA-Z]+)"/g)].map(m => m[1]).sort();
        expect(axes).toEqual(EXPECTED_AXES);
    });
});

describe("Tool registry stays 22 (FOSE off) and 1:1 with the per-tool docs", () => {
    const reg = buildDefaultRegistry();
    const registered = reg.list().map(t => t.name).sort();

    it("registers exactly 22 live tools with the two FOSE tools absent", () => {
        expect(registered.length).toBe(22);
        expect(registered).not.toContain("materialize_feasible");
        expect(registered).not.toContain("propose_section_replan");
    });

    it("Docs/current-system/tools/*.md is 1:1 with the registry", () => {
        const docDir = join(REPO_ROOT, "Docs", "current-system", "tools");
        const docTools = readdirSync(docDir)
            .filter(f => f.endsWith(".md"))
            .map(f => f.replace(/\.md$/, ""))
            .sort();
        expect(docTools).toEqual(registered);
    });
});
