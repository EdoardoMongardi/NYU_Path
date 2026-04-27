// ============================================================
// T2 Candidate Promotion (Phase 6.1 WS8)
// ============================================================
// Move a Zod-validated candidate from `data/programs/_candidates/`
// into the loaded programs directory `data/programs/<school>/`.
// Asserts a human spot-check has been recorded before promotion.
//
// Usage:
//   pnpm tsx tools/program-extractor/promote.ts --programId cas_philosophy_ba --school cas --spotCheckedBy <name>
// ============================================================

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validateProgramBody } from "../../packages/engine/src/provenance/configSchema.js";
import { validateFileWithMeta } from "../../packages/engine/src/provenance/schema.js";

function parseFlag(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
    const programId = parseFlag("programId");
    const school = parseFlag("school");
    const spotCheckedBy = parseFlag("spotCheckedBy");
    if (!programId || !school || !spotCheckedBy) {
        process.stderr.write("Required flags: --programId <id> --school <school-id> --spotCheckedBy <name>\n");
        process.exit(1);
    }

    const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
    const candidatePath = join(repoRoot, "data/programs/_candidates", `${programId}.json`);
    if (!existsSync(candidatePath)) {
        process.stderr.write(`No candidate at ${candidatePath}.\n`);
        process.exit(1);
    }
    const raw = JSON.parse(readFileSync(candidatePath, "utf-8"));

    // Re-validate before promoting (the candidate file may have been
    // hand-edited during the spot-check).
    const meta = validateFileWithMeta(raw);
    if (!meta.ok) {
        process.stderr.write("Candidate _meta validation failed:\n" + meta.errors.map((e) => "  - " + e).join("\n") + "\n");
        process.exit(2);
    }
    const body = validateProgramBody({ ...raw });
    if (!body.ok) {
        process.stderr.write("Candidate body validation failed:\n" + body.errors.map((e) => "  - " + e).join("\n") + "\n");
        process.exit(2);
    }

    // Stamp the spot-checker into _meta.verifiedBy (overwrite "spot-check" placeholder).
    raw._meta.verifiedBy = `spot-check:${spotCheckedBy}`;

    const targetDir = join(repoRoot, "data/programs", school);
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${programId}.json`);
    writeFileSync(targetPath, JSON.stringify(raw, null, 4) + "\n", "utf-8");

    // Remove the candidate.
    renameSync(candidatePath, candidatePath + ".promoted");

    process.stdout.write(`Promoted: ${targetPath}\nCandidate marked: ${candidatePath}.promoted\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
