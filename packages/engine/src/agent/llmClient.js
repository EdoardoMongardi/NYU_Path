// ============================================================
// LLMClient interface for the agent loop (Phase 5 §6)
// ============================================================
// Mirrors the bakeoff's LLMClient (`evals/llmClients.ts`) but lives in
// the engine package so tests don't pull in eval-only dependencies.
// Implementations: a thin OpenAI/Anthropic wrapper for production, a
// `RecordingLLMClient` that replays JSONL fixtures for unit tests.
// ============================================================
export {};
//# sourceMappingURL=llmClient.js.map