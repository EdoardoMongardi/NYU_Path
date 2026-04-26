// ============================================================
// Policy Template Loader (Phase 4 §5.5)
// ============================================================
// Loads `data/policy_templates/*.json` and returns the array of
// PolicyTemplate objects. Each file carries a `_meta` block validated
// by the Phase 0 provenance schema.
// ============================================================

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateFileWithMeta } from "../provenance/schema.js";
import { validatePolicyTemplateBody } from "../provenance/configSchema.js";
import type { PolicyTemplate } from "./policyTemplate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DATA_DIR = join(__dirname, "..", "..", "..", "..", "data");
const TEMPLATES_DIR = join(REPO_DATA_DIR, "policy_templates");

export interface PolicyTemplateLoadResult {
    templates: PolicyTemplate[];
    /** Files that failed _meta validation; surfaced for telemetry but do not block the load */
    skipped: Array<{ path: string; errors: string[] }>;
}

export function loadPolicyTemplates(opts?: { templatesDir?: string }): PolicyTemplateLoadResult {
    const dir = opts?.templatesDir ?? TEMPLATES_DIR;
    const templates: PolicyTemplate[] = [];
    const skipped: PolicyTemplateLoadResult["skipped"] = [];

    if (!existsSync(dir)) return { templates, skipped };
    const entries = readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const entry of entries) {
        const path = join(dir, entry);
        let parsed: unknown;
        try {
            parsed = JSON.parse(readFileSync(path, "utf-8"));
        } catch (err) {
            skipped.push({ path, errors: [err instanceof Error ? err.message : String(err)] });
            continue;
        }
        const metaResult = validateFileWithMeta(parsed);
        if (!metaResult.ok) {
            skipped.push({ path, errors: metaResult.errors });
            continue;
        }
        const { _meta: _meta, ...body } = parsed as { _meta: unknown } & Record<string, unknown>;
        const bodyResult = validatePolicyTemplateBody(body);
        if (!bodyResult.ok) {
            skipped.push({ path, errors: bodyResult.errors });
            continue;
        }
        templates.push(bodyResult.body as unknown as PolicyTemplate);
    }
    return { templates, skipped };
}
