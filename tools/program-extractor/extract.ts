// ============================================================
// T2 Program Extractor (Phase 6.1 WS8)
// ============================================================
// Reads a bulletin markdown file → calls the production LLM via
// `OpenAIEngineClient` with `tools/program-extractor/prompt.md` →
// validates the returned JSON against the engine's `programBodySchema`
// → writes the candidate to `data/programs/_candidates/<programId>.json`.
//
// Usage:
//   pnpm tsx tools/program-extractor/extract.ts \
//     --bulletin data/bulletin-raw/.../philosophy-ba/_index.md \
//     --programId cas_philosophy_ba \
//     --department Philosophy
//
// The candidate file is NOT auto-promoted to data/programs/<school>/.
// A human must spot-check ≥10% of rules (min 5) and run
// `tools/program-extractor/promote.ts` to move it into the loaded
// programs directory. Per §11.6.4.
// ============================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { OpenAIEngineClient, DEFAULT_PRIMARY_MODEL } from "@nyupath/engine";
import { validateProgramBody } from "../../packages/engine/src/provenance/configSchema.js";

interface ExtractArgs {
    bulletinPath: string;
    programId: string;
    department: string;
    school: string;
    sourceUrl: string;
    catalogYear: string;
    apiKey: string;
    repoRoot: string;
}

function sha256(text: string): string {
    return "sha256:" + createHash("sha256").update(text).digest("hex");
}

function readPrompt(repoRoot: string): string {
    return readFileSync(join(repoRoot, "tools/program-extractor/prompt.md"), "utf-8");
}

export async function extractProgram(args: ExtractArgs): Promise<{ ok: true; candidatePath: string } | { ok: false; errors: string[] }> {
    const bulletin = readFileSync(args.bulletinPath, "utf-8");
    const bulletinHash = sha256(bulletin);
    const promptTemplate = readPrompt(args.repoRoot);
    const today = new Date().toISOString().slice(0, 10);

    const userPrompt = [
        promptTemplate,
        "",
        "---",
        "",
        `BULLETIN MARKDOWN (sourceUrl=${args.sourceUrl}, sourceHash=${bulletinHash}):`,
        "",
        bulletin,
        "",
        "---",
        "",
        `Required output values:`,
        `- programId: "${args.programId}"`,
        `- school: "${args.school}"`,
        `- department: "${args.department}"`,
        `- catalogYear: "${args.catalogYear}"`,
        `- _meta.sourceUrl: "${args.sourceUrl}"`,
        `- _meta.sourceHash: "${bulletinHash}"`,
        `- _meta.lastVerified: "${today}"`,
    ].join("\n");

    const client = new OpenAIEngineClient({
        modelId: DEFAULT_PRIMARY_MODEL,
        apiKey: args.apiKey,
    });
    const completion = await client.complete({
        system:
            "You are a precise structured-data extractor. Output ONLY a single JSON object matching the schema described in the user message. No prose, no markdown fences.",
        messages: [{ role: "user", content: userPrompt }],
        maxTokens: 4096,
        temperature: 0,
    });

    let parsed: unknown;
    try {
        // Strip code fences if the model added them despite instructions.
        const text = completion.text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
        parsed = JSON.parse(text);
    } catch (e) {
        return {
            ok: false,
            errors: [`Failed to parse LLM output as JSON: ${e instanceof Error ? e.message : String(e)}`],
        };
    }

    const validation = validateProgramBody(parsed);
    if (!validation.ok) return { ok: false, errors: validation.errors };

    const candidateDir = join(args.repoRoot, "data/programs/_candidates");
    if (!existsSync(candidateDir)) mkdirSync(candidateDir, { recursive: true });
    const candidatePath = join(candidateDir, `${args.programId}.json`);
    writeFileSync(candidatePath, JSON.stringify(parsed, null, 4) + "\n", "utf-8");
    return { ok: true, candidatePath };
}

// ----------------------------------------------------------------
// CLI entry point
// ----------------------------------------------------------------

function parseFlag(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        process.stderr.write("OPENAI_API_KEY is required.\n");
        process.exit(1);
    }
    const bulletinPath = parseFlag("bulletin");
    const programId = parseFlag("programId");
    const department = parseFlag("department");
    const school = parseFlag("school") ?? "CAS";
    const sourceUrl = parseFlag("sourceUrl") ?? "";
    const catalogYear = parseFlag("catalogYear") ?? "2025-2026";
    if (!bulletinPath || !programId || !department) {
        process.stderr.write("Required flags: --bulletin <path> --programId <id> --department <name> [--school CAS] [--sourceUrl ...] [--catalogYear 2025-2026]\n");
        process.exit(1);
    }
    const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
    const result = await extractProgram({
        bulletinPath: resolve(bulletinPath),
        programId,
        department,
        school,
        sourceUrl,
        catalogYear,
        apiKey,
        repoRoot,
    });
    if (result.ok) {
        process.stdout.write(`Candidate written: ${result.candidatePath}\nReview ≥10% of rules (min 5) before running promote.ts.\n`);
    } else {
        process.stderr.write("Extraction failed:\n" + result.errors.map((e) => "  - " + e).join("\n") + "\n");
        process.exit(2);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
