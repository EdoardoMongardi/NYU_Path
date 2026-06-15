// ============================================================
// D7.2 — v2 route proactive-elicitation APPEND (append-not-substitute)
// ============================================================
// End-to-end route proof that, on the OK terminal path, the route
// APPENDS one bounded proactive question to `done.finalText` rather than
// substituting it for the agent's answer. We mock ONLY the streaming
// agent loop (so no real LLM call) and force the conservative D7.1
// detector to fire via a stub — keeping the REAL `decideElicitationAppend`
// + `elicitationQuestionFor` + `ELICITATION_LEAD_IN` so the actual
// append decision + question text are exercised. The DPR fixture's
// student has a declared major (so the natural `planning_without_
// declared_program` signal would NOT fire); stubbing the detector lets us
// pin the WIRING (append-not-substitute, gated on allOk) independent of
// the fixture's program data. The pure-function tests in
// packages/engine/tests/agent/proactiveElicitation.test.ts remain the
// load-bearing guarantee for the decision logic itself.
// ============================================================

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POST } from "../app/api/chat/v2/route";
import {
    parseDpr,
    ELICITATION_LEAD_IN,
    type ChatTurnResult,
} from "@nyupath/engine";
import { resetStoresForTests } from "../lib/db/store";

// The canonical agent answer the mocked loop returns. It is a clean
// statement (no trailing "?", no lead-in marker) so the append guards
// don't suppress, and it passes the response validator (allOk) so the
// append actually fires.
const AGENT_ANSWER = "You can plan your courses for next semester.";

// Mock ONLY the streaming agent loop + force the proactive detector to
// fire. importOriginal keeps `decideElicitationAppend`,
// `elicitationQuestionFor`, `ELICITATION_LEAD_IN`, `validateResponse`,
// etc. all REAL.
vi.mock("@nyupath/engine", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@nyupath/engine")>();
    return {
        ...actual,
        runAgentTurnStreaming: async function* () {
            const result: ChatTurnResult = {
                kind: "ok",
                finalText: AGENT_ANSWER,
                invocations: [],
                turnMessages: [],
                usage: { promptTokens: 0, completionTokens: 0 },
                modelUsedId: "test-model",
                transitions: [],
            };
            yield { type: "done" as const, result };
        },
        // Force the conservative D7.1 detector to report an opportunity so
        // the route's append path runs. The real `decideElicitationAppend`
        // (un-mocked) then makes the actual decision.
        detectElicitationOpportunity: () => ({
            shouldElicit: true,
            signals: ["planning_without_declared_program"],
            topic: "intended_major",
        }),
    };
});

const DPR_FIXTURE = readFileSync(
    join(__dirname, "..", "..", "..", "packages/engine/tests/fixtures/dpr_sample.redacted.txt"),
    "utf-8",
);
function validDprPayload(): { kind: "dpr"; report: unknown } {
    const r = parseDpr(DPR_FIXTURE, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
    if (!r.ok) throw new Error("DPR fixture failed to parse");
    return { kind: "dpr", report: r.report };
}

function fakeRequest(body: unknown): { json: () => Promise<unknown> } {
    return { json: async () => body };
}

async function drainSse(res: Response): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
    }
    return body;
}

/** Extract the `done` event's finalText from the drained SSE text. */
function doneFinalText(sse: string): string {
    // Each SSE message is `event: <kind>\ndata: <json>\n\n`. Find the
    // `done` event's data line and parse its `finalText`.
    const lines = sse.split("\n");
    for (let i = 0; i < lines.length; i++) {
        if (lines[i] === "event: done") {
            const dataLine = lines.slice(i + 1).find((l) => l.startsWith("data: "));
            if (dataLine) {
                const payload = JSON.parse(dataLine.slice("data: ".length));
                return typeof payload.finalText === "string" ? payload.finalText : "";
            }
        }
    }
    return "";
}

describe("v2 route proactive elicitation — append-not-substitute (D7.2)", () => {
    const ORIGINAL = {
        openai: process.env.OPENAI_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY,
        dbUrl: process.env.DATABASE_URL,
        sessionPath: process.env.NYUPATH_SESSION_STORE_PATH,
    };

    beforeEach(() => {
        delete process.env.DATABASE_URL;
        delete process.env.NYUPATH_SESSION_STORE_PATH;
        process.env.OPENAI_API_KEY = "sk-test-fake-key-for-elicitation-test";
        process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake-key-for-elicitation-test";
        resetStoresForTests();
    });

    afterEach(() => {
        if (ORIGINAL.openai === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = ORIGINAL.openai;
        if (ORIGINAL.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = ORIGINAL.anthropic;
        if (ORIGINAL.dbUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = ORIGINAL.dbUrl;
        if (ORIGINAL.sessionPath === undefined) delete process.env.NYUPATH_SESSION_STORE_PATH;
        else process.env.NYUPATH_SESSION_STORE_PATH = ORIGINAL.sessionPath;
        resetStoresForTests();
        vi.restoreAllMocks();
    });

    it("appends ONE bounded question to done.finalText without replacing the answer", async () => {
        const res = await POST(fakeRequest({
            message: "What should I take next semester?",
            parsedData: validDprPayload(),
            history: [],
        }) as never);
        expect(res.status).toBe(200);

        const sse = await drainSse(res);
        const finalText = doneFinalText(sse);

        // Append-not-substitute, proven end-to-end:
        // 1. The ORIGINAL agent answer is still fully present.
        expect(finalText).toContain(AGENT_ANSWER);
        // 2. The answer is a PREFIX — the question is appended AFTER it.
        expect(finalText.startsWith(AGENT_ANSWER)).toBe(true);
        // 3. The appended bounded question (the lead-in marker) is present,
        //    and the message now ends with the proactive question.
        expect(finalText).toContain(ELICITATION_LEAD_IN);
        expect(finalText.trim().endsWith("?")).toBe(true);
        // 4. It is strictly LONGER than the bare answer (genuinely additive).
        expect(finalText.length).toBeGreaterThan(AGENT_ANSWER.length);
    });
});
