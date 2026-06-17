import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        include: [
            "packages/*/tests/**/*.test.ts",
            // F1 — the apps glob matches BOTH `.test.ts` (node-env unit
            // tests) and `.test.tsx` (React render tests). The render
            // tests declare their own jsdom env per-file via a
            // `// @vitest-environment jsdom` docblock comment, so the rest
            // of the suite stays on the default node environment.
            "apps/*/tests/**/*.test.{ts,tsx}",
            "evals/tests/**/*.test.ts",
            // Phase 14 Task 8 — operator-gated eval suites (*.eval.ts).
            // The LLM-call runner inside is gated by ANTHROPIC_API_KEY.
            // The 2 inline unit tests (fixture-count + Dneg invariant) run unconditionally.
            "packages/*/tests/**/*.eval.ts",
            // Phase 14 Task 9 — tools/bulletin-parser unit tests (no LLM calls).
            "tools/bulletin-parser/**/*.test.ts",
        ],
    },
});
