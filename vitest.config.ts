import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        include: [
            "packages/*/tests/**/*.test.ts",
            "apps/*/tests/**/*.test.ts",
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
