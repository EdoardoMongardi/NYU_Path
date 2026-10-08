// ============================================================
// /api/chat/v2 request body schema
// ============================================================
// Everything in the body is caller-controlled and much of it reaches
// the LLM (`message` as the user turn, `history` as prior messages), so
// the route validates the whole body BEFORE any store read, rate-limit
// charge or model call:
//   - `message`: a non-empty string of at most CHAT_MESSAGE_MAX_CHARS;
//   - `history`: at most CHAT_HISTORY_MAX_ITEMS items, each exactly
//     `{ role: "user" | "assistant", content: string }` with content at
//     most CHAT_HISTORY_ITEM_MAX_CHARS — a `system` (or any other) role
//     can't be smuggled into the agent's prior messages;
//   - the small string fields are length-capped (`graduationTarget`,
//     free text the student typed, is truncated instead).
// `parsedData` stays `unknown` here: the route checks it is a DPR
// payload (with its own onboarding prompt) and validates the report
// against the engine's DPR schema. Unknown keys are stripped.
// ============================================================

import { z } from "zod";
import {
    CHAT_HISTORY_ITEM_MAX_CHARS,
    CHAT_HISTORY_MAX_ITEMS,
    CHAT_MESSAGE_MAX_CHARS,
} from "./chatV2Client";

const MESSAGE_REQUIRED = "`message` is required and must be a string.";
const GRADUATION_TARGET_MAX_CHARS = 200;

export const V2RequestBodySchema = z.object({
    message: z
        .string({ error: MESSAGE_REQUIRED })
        .min(1, { error: MESSAGE_REQUIRED })
        .max(CHAT_MESSAGE_MAX_CHARS, {
            error: `\`message\` is too long (max ${CHAT_MESSAGE_MAX_CHARS} characters).`,
        }),
    /** Onboarding artifact — the route requires `{ kind: "dpr", report }`. */
    parsedData: z.unknown().optional(),
    visaStatus: z.string().max(32).nullish(),
    /** Collected during onboarding, free-form text the student typed
     *  (e.g., "Spring 2027", or a whole sentence). Only the season + year
     *  `normalizeGraduationTarget` extracts reaches the prompt, so an
     *  over-long value is TRUNCATED, never rejected — rejecting it would
     *  fail every turn of the session, since the page re-sends it. */
    graduationTarget: z
        .string()
        .transform((s) => s.slice(0, GRADUATION_TARGET_MAX_CHARS))
        .nullish(),
    history: z
        .array(
            z.object({
                role: z.enum(["user", "assistant"]),
                content: z.string().max(CHAT_HISTORY_ITEM_MAX_CHARS),
            }),
        )
        .max(CHAT_HISTORY_MAX_ITEMS)
        .optional(),
    correlationId: z.string().max(128).optional(),
    /** Phase 7-A: stable user id (cookie-derived when authenticated,
     *  per-browser UUID otherwise). Used for the per-student daily
     *  rate limit, session-summary persistence, and end-of-turn writes. */
    userId: z.string().max(128).optional(),
    /** CAS-1 (Task 1.5): onboarding-confirmed home school for this student
     *  (e.g. "cas", "stern", "tandon", "shanghai", "nyuad", …). The route
     *  validates it against the school registry before it is used. */
    homeSchool: z.string().max(64).optional(),
});

export type V2RequestBody = z.infer<typeof V2RequestBodySchema>;

/** One-line 400 message for a failed parse: a `message` problem keeps its
 *  own wording; anything else names up to three offending paths. */
export function formatV2BodyError(error: z.ZodError): string {
    const messageIssue = error.issues.find((i) => i.path[0] === "message");
    if (messageIssue) return messageIssue.message;
    const detail = error.issues
        .slice(0, 3)
        .map((i) => `${i.path.map(String).join(".") || "(body)"}: ${i.message}`)
        .join("; ");
    return `Invalid request body — ${detail}.`;
}
