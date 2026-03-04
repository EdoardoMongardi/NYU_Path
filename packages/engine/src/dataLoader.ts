// ============================================================
// Data Loader — Load JSON data files
// ============================================================
import type { Course, Prerequisite, Program } from "@nyupath/shared";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");

export function loadCourses(): Course[] {
    const raw = readFileSync(join(DATA_DIR, "courses.json"), "utf-8");
    return JSON.parse(raw) as Course[];
}

export function loadPrereqs(): Prerequisite[] {
    const raw = readFileSync(join(DATA_DIR, "prereqs.json"), "utf-8");
    return JSON.parse(raw) as Prerequisite[];
}

export function loadPrograms(): Program[] {
    const raw = readFileSync(join(DATA_DIR, "programs.json"), "utf-8");
    return JSON.parse(raw) as Program[];
}

export function loadProgram(programId: string, catalogYear?: string): Program | undefined {
    const programs = loadPrograms();
    return programs.find(
        (p) =>
            p.programId === programId &&
            (catalogYear ? p.catalogYear === catalogYear : true)
    );
}
