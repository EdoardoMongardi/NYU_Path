// ============================================================
// Phase 7-B Step 3d — DB ↔ bulletin markdown alignment guard
// ============================================================
// Verifies that every subject prefix in the Postgres-derived
// course descriptions JSON has a matching `_index.md` under
// `data/bulletin-raw/courses/`. The alignment is the precondition
// for the drift guard at phase4.test.ts (it lets a policy template
// quote a course title and have a markdown file to validate
// against).
//
// 44 variant-suffix course codes (e.g., "CDAD-UH 1005EQ") are
// expected to appear in the DB but not in the bulletin — the
// bulletin lists the canonical course (e.g., "CDAD-UH 1005").
// We assert subject-level coverage only.
// ============================================================

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DESCRIPTIONS_PATH = join(REPO_ROOT, "data/course-catalog/course_descriptions.json");
const COURSES_DIR = join(REPO_ROOT, "data/bulletin-raw/courses");

describe("Course catalog ↔ bulletin alignment (Phase 7-B Step 3d)", () => {
    it("every subject prefix in the DB has a matching _index.md in data/bulletin-raw/courses/", () => {
        if (!existsSync(DESCRIPTIONS_PATH) || !existsSync(COURSES_DIR)) {
            // Skip when the data files aren't checked out (CI without
            // the artifacts is acceptable; this is a local-dev guard).
            return;
        }

        const desc = JSON.parse(readFileSync(DESCRIPTIONS_PATH, "utf-8")) as {
            courses: Array<{ courseCode: string }>;
        };
        const dbSubjects = new Set<string>();
        for (const c of desc.courses) {
            const prefix = c.courseCode.split(" ")[0];
            if (!prefix) continue;
            dbSubjects.add(prefix.toLowerCase().replace(/-/g, "_"));
        }

        const dirSubjects = new Set(
            readdirSync(COURSES_DIR).filter((d) => !d.startsWith("_")),
        );

        const missing: string[] = [];
        for (const s of dbSubjects) {
            if (!dirSubjects.has(s)) missing.push(s);
        }
        expect(missing).toEqual([]);
    });
});
