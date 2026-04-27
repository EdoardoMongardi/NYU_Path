// ============================================================
// Course-catalog semantic search wiring (Phase 7-B Step 3c)
// ============================================================
// Lazy-loaded singleton that injects an OpenAI-backed
// `CourseSearchFn` into the chat session so `search_courses`
// returns semantic top-K matches over the full 17,122-course
// catalog dumped from nyucourses Postgres.
//
// Loading is gated on first use — endpoints that never call the
// agent (e.g., onboarding) never pay the ~100 MB load cost.
// ============================================================

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
    OpenAIEmbedder,
    createSemanticCourseSearchFn,
    type CourseSearchFn,
} from "@nyupath/engine";

const REPO_ROOT = process.cwd().includes("apps/web")
    ? join(process.cwd(), "..", "..")
    : process.cwd();

const DESCRIPTIONS_PATH = join(REPO_ROOT, "data/course-catalog/course_descriptions.json");
const EMBEDDINGS_PATH = join(REPO_ROOT, "data/course-catalog/course_embeddings_openai.jsonl");
const EMBEDDINGS_META_PATH = join(REPO_ROOT, "data/course-catalog/course_embeddings_openai.meta.json");

let cached: CourseSearchFn | null = null;
let cachedFailureReason: string | null = null;

export function getCourseSearchFn(): CourseSearchFn | null {
    if (cached) return cached;
    if (cachedFailureReason) return null;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        cachedFailureReason = "OPENAI_API_KEY not set";
        return null;
    }
    if (!existsSync(DESCRIPTIONS_PATH) || !existsSync(EMBEDDINGS_PATH)) {
        cachedFailureReason = `course-catalog artifacts missing at ${DESCRIPTIONS_PATH} / ${EMBEDDINGS_PATH}`;
        // eslint-disable-next-line no-console
        console.warn(`[courseCatalogSearch] ${cachedFailureReason}; search_courses will return zero matches.`);
        return null;
    }

    try {
        const embedder = new OpenAIEmbedder({ apiKey });
        cached = createSemanticCourseSearchFn({
            embedder,
            descriptionsPath: DESCRIPTIONS_PATH,
            embeddingsPath: EMBEDDINGS_PATH,
            embeddingsMetaPath: EMBEDDINGS_META_PATH,
        });
        return cached;
    } catch (err) {
        cachedFailureReason = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(`[courseCatalogSearch] failed to construct semantic search: ${cachedFailureReason}`);
        return null;
    }
}
