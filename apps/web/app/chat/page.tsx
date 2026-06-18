"use client";

import { useState, useRef, useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import styles from "./chat.module.css";
import {
    streamChatV2,
    extractPendingMutationId,
    streamPlanActionPolish,
    streamPlanActionStage2,
    type ChatV2Event,
    type ForwardMaterializationPayload,
} from "../../lib/chatV2Client";
import { getPastVerb, getThoughtSentence } from "../../lib/agentStatusVerbs";
import { formatDuration } from "../../lib/formatDuration";
import { renderMarkdown } from "../../lib/renderMarkdown";
import type { ForwardSchedule, SchedulePreferences, StudentProfile } from "@nyupath/shared";
import type { ChatMessageRecord, ToolInvocation, DegreeProgressReport } from "@nyupath/engine";
import { buildStudentProfileFromDpr } from "../../lib/buildSession";
// H5.1 (plan 36) — the RIGHT zone is now the profile-only ProfileRail.
// `scheduleSidebar.tsx` lingers UNMOUNTED (its grid + slot popovers +
// review/preview card moved to the CENTER-zone ScheduleWorkspace; its
// G3.2 what-if control is intentionally removed — what-ifs are chat-only).
// H7 decides the dead file's fate.
import ProfileRail from "./ProfileRail";
import {
    bubbleSlotKey,
    bubbleHasButtons,
    bubbleHasOverrideButton,
    initBubbleState,
    applyPolishEvent,
    applyStage2Event,
    type PlanActionBubbleState,
} from "../../lib/planActionBubbleHelpers";
import {
    planConfirm,
    type PlanActionResult,
    type PlanActionRouteResponse,
    type WhatIfAssumptionRouteResponse,
} from "../../lib/planActionClient";
import { createPlanStore, type Scenario } from "./planState";
import ThreeZoneShell from "./workspace/ThreeZoneShell";
import { applyReviewConfirm, applyReviewCancel } from "../../lib/reviewCard";
import { planActionSurfaces } from "../../lib/planActionSurfaces";
import {
    buildExplainSlotQuestion,
    buildExplainTermQuestion,
    buildExplainProposalQuestion,
} from "../../lib/explainQuestion";
import { buildPreferenceTurns } from "../../lib/wizard/preferenceTurns";
import { buildIntendedMajorPreviewTurn } from "../../lib/wizard/intendedMajor";
import type { WizardValues } from "../../lib/wizard/wizardMachine";
import OnboardingWizard from "./wizard/OnboardingWizard";
import ScheduleCard from "./ScheduleCard";
import WhatIfUploadCard from "./WhatIfUploadCard";
import { buildScheduleCardMessage } from "./buildScheduleCardMessage";
import {
    buildWhatIfScenarioFromAudit,
    type WhatIfAuditResponse,
} from "./buildWhatIfScenarioFromAudit";
import type { ScenarioKind } from "./workspace/scenarioBadges";

// Char-reveal rates for the ChatGPT-style typewriter animations.
// Tuned by feel: thinking should read like deliberative reasoning;
// the final answer should feel snappy, like ChatGPT post-token.
const THINKING_CHARS_PER_SEC = 60;
const CONTENT_CHARS_PER_SEC = 220;

// Phase 7-E W10 reviewer P1-2 — stable per-browser UUID so each
// student gets their own rate-limit bucket (instead of every
// cohort-A user sharing a single "anonymous" bucket). Stored in
// localStorage; a fresh browser/incognito-session gets a new id.
// Replaced by real auth-derived ids in W12.
const USER_ID_LS_KEY = "nyupath:client-id";
function getOrCreateClientId(): string {
    if (typeof window === "undefined") return "anonymous";
    try {
        const cached = window.localStorage.getItem(USER_ID_LS_KEY);
        if (cached) return cached;
        const next = window.crypto?.randomUUID
            ? window.crypto.randomUUID()
            : `cohortA-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        window.localStorage.setItem(USER_ID_LS_KEY, next);
        return next;
    } catch {
        return "anonymous";
    }
}

interface ToolStatus {
    toolName: string;
    state: "running" | "done" | "error";
    summary?: string;
    error?: string;
}

interface Message {
    id: string;
    role: "user" | "assistant";
    content: string;
    timestamp: Date;
    /** Phase 17 Task D follow-up — discriminator for the new
     *  `plan_action_bubble` kind. `undefined` = a regular chat
     *  bubble (the existing render path); `"plan_action_bubble"`
     *  swaps the render to the bubble + buttons block.
     *  H4.2a — `"schedule_card"` swaps the render to the ScheduleCard
     *  component, showing an openable/comparable artifact in the chat
     *  thread whenever the engine produces a new proposed schedule.
     *  H4.2b-3 — `"whatif_upload_card"` swaps the render to the
     *  WhatIfUploadCard, offering a Branch-A Albert What-If audit upload
     *  for a hypothetical PROGRAM (→ a read-only 🔍 what-if scenario). */
    kind?: "plan_action_bubble" | "schedule_card" | "whatif_upload_card";
    /** H4.2a — populated only when `kind === "schedule_card"`. Holds
     *  the scenario id, kind, label, optional summary, and optional
     *  verdict to render as a ScheduleCard in the chat thread. */
    scheduleCard?: {
        scenarioId: string;
        kind: ScenarioKind;
        label: string;
        summary?: string;
        verdict?: "valid" | "trade-offs" | "invalid";
    };
    /** H4.2b-3 — populated only when `kind === "whatif_upload_card"`.
     *  Holds the hypothetical program the agent offered to explore via a
     *  Branch-A Albert What-If audit upload. */
    whatifUpload?: { hypotheticalProgram: string };
    /** Phase 17 Task D follow-up — populated only when
     *  `kind === "plan_action_bubble"`. Holds the bubble's
     *  template/polished text, the verb, the pendingMutationId
     *  (Confirm / Override-anyway target), the bubble category
     *  (clean | trade_offs | soft_refusal | hard_refusal), and the
     *  Stage 2 enrichment Map. Mutated by the polish + Stage 2 SSE
     *  reducers. */
    bubble?: PlanActionBubbleState;
    /** Phase 17 Task D follow-up — verb that triggered the bubble
     *  (used for analytics + the bubble's lead-in). */
    bubbleVerb?: "add" | "swap" | "drop" | "lock" | "move";
    /** Phase 17 Task D follow-up — true once Confirm / Keep-as-is /
     *  Override-anyway has fired so we can disable the buttons +
     *  hide them while the confirm round-trip is in flight. */
    bubbleResolved?: boolean;
    /** Per-message tool-invocation log (rendered inline above the bubble) */
    toolStatuses?: ToolStatus[];
    /** Per-message validator violations (rendered as a warning chip below the bubble) */
    validatorViolations?: Array<{ kind: string; detail: string; caveatId?: string }>;
    /** Phase 5 §7.2 two-step profile-update affordance — present when
     *  this message reports a `pendingMutationId` from `update_profile`. */
    pendingMutationId?: string;
    /** Agent-status UX: epoch ms when the v2 stream was opened. Set
     *  on assistant messages only; absent on welcome / v1 / user. */
    startedAt?: number;
    /** Agent-status UX: epoch ms when the `done` SSE event arrived. */
    completedAt?: number;
    /** Agent-status UX: epoch ms when an `error` event arrived. Used
     *  to render "Failed after Xs" instead of "Thought for Xs". */
    failedAt?: number;
    /** Agent-status UX: whether the user has expanded the reasoning block. */
    traceExpanded?: boolean;
    /** Reasoning text that streams above the final answer. Holds real
     *  Anthropic chain-of-thought when `hasRealThinking` is set,
     *  otherwise a fallback of synthesized tool-sentence narration
     *  (one sentence per tool fired). */
    thinkingText?: string;
    /** How many chars of `thinkingText` are currently revealed
     *  (typewriter animation; ticker bumps this up over time). */
    thinkingRevealed?: number;
    /** How many chars of `content` are currently revealed in the
     *  final-answer bubble. Drives the ChatGPT-style streaming. */
    contentRevealed?: number;
    /** True once at least one `thinking` SSE event has fired for this
     *  message. When set, suppresses the synthesized tool-thought
     *  fallback so we don't double-narrate (real reasoning + canned
     *  sentences). Stays unset on OpenAI-fallback turns and template-
     *  match recovery, where the synthesized fallback is what the
     *  user sees. */
    hasRealThinking?: boolean;
}

type OnboardingStep = "awaiting_dpr" | "confirming_data" | "correcting_data" | "asking_visa" | "asking_graduation" | "complete";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ParsedTranscript = Record<string, any>;

const WELCOME_MESSAGE: Message = {
    id: "welcome",
    role: "assistant",
    content: `Welcome to **NYU Path** 🎓\n\nI'll help you plan your courses and track your degree progress.\n\nTo get started, please upload your **Degree Progress Report (DPR)** as a PDF.\n\nIn Albert: **Academics tab → Planning Tools → Degree Progress Report**. When the report opens in a new window, save it as PDF (browser print → "Save as PDF") and drop it below.\n\n📎 Drag & drop or click to upload!`,
    timestamp: new Date(),
};

function isInFlight(m: Message): boolean {
    return m.role === "assistant" && !!m.startedAt && !m.completedAt && !m.failedAt;
}

export default function ChatPage() {
    const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>("awaiting_dpr");
    const [isDragOver, setIsDragOver] = useState(false);
    const [parsedData, setParsedData] = useState<ParsedTranscript | null>(null);
    const [visaStatus, setVisaStatus] = useState<string | null>(null);
    const [graduationTarget, setGraduationTarget] = useState<string | null>(null);
    // E5.2 — the onboarding-confirmed home-school CODE (e.g. "cas",
    // "stern", "shanghai", "nyuad"). Set from the wizard's Confirm-profile
    // step (onReachPlan) and from /api/session/restore's persisted profile.
    // Sent as `body.homeSchool` on chat turns ONLY when set — NEVER
    // silently CAS (null = unconfirmed → the field is omitted).
    const [homeSchool, setHomeSchool] = useState<string | null>(null);
    // Phase 4 Task E1.1 — single source of truth for plan state.
    // forwardSchedule + schedulePreferences + forwardMaterialization
    // used to be three independent server-push-only `useState`s. They
    // are now one shared, subscribable store (`./planState`) so
    // chat-driven SSE updates AND sidebar-driven edits write to the
    // SAME state and every consumer re-renders from it. The store is
    // created once per page mount; setters dispatch into it; reads come
    // from the `useSyncExternalStore` snapshot below.
    //   - forwardSchedule: hydrated from /api/session/restore on mount;
    //     pushed live by the `forward_schedule_update` SSE event;
    //     refreshed after each successful /api/plan/confirm round-trip.
    //   - schedulePreferences (Phase 17 Task D): drives the sidebar's
    //     freeze-flag plumb-through (Lock popover label flips to
    //     "Unlock" when a slot is in pins[]).
    //   - forwardMaterialization (Phase 15 Task 8): captured from the
    //     `forward_materialization_update` SSE event when the agent runs
    //     `materialize_sections`; drives the sidebar's IMMEDIATE-term
    //     render (full → Sections view; partial/unavailable → banner).
    const planStore = useMemo(() => createPlanStore(), []);
    const { forwardSchedule, schedulePreferences, forwardMaterialization, pendingPreview, invalidProposal } =
        useSyncExternalStore(planStore.subscribe, planStore.getSnapshot, planStore.getSnapshot);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    // Phase 4 Task E6.4 — in-flight guard for the standing
    // self-serve account-deletion control (disables the button so a
    // student can't fire DELETE /api/session/delete twice).
    const [deletingAccount, setDeletingAccount] = useState(false);
    // H5.1 (plan 36) — in-flight guard for the ProfileRail "↻ Update DPR"
    // control. The scheduleSidebar formerly held this `refreshing` state
    // internally; with the profile-level concerns lifted to the rail, the
    // page owns it (the rail's `refreshing` prop only disables + relabels
    // the button — the actual fetch lives in handleRefreshDpr below).
    const [refreshingDpr, setRefreshingDpr] = useState(false);
    // H4.2b-3 — per-card busy/error state for the Branch-A What-If audit
    // upload cards, keyed by the card message id (so multiple offer cards
    // in the thread track independently).
    const [whatifUploadBusy, setWhatifUploadBusy] = useState<Record<string, boolean>>({});
    const [whatifUploadError, setWhatifUploadError] = useState<Record<string, string>>({});
    const fileInputRef = useRef<HTMLInputElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    /**
     * Single rAF-driven typewriter ticker. Walks the messages array
     * each frame and bumps `thinkingRevealed` / `contentRevealed`
     * forward by `rate * elapsed` chars. Once the message is
     * `completedAt` / `failedAt`, thinking snaps to full and content
     * starts streaming. All reveal counters are clamped at the full
     * length, so a settled message renders as a no-op.
     */
    useEffect(() => {
        let raf = 0;
        let lastTime = performance.now();
        const tick = (now: number) => {
            const elapsed = Math.min(100, now - lastTime); // clamp to avoid huge jumps after tab-switch
            lastTime = now;
            setMessages(prev => {
                let changed = false;
                const next = prev.map(m => {
                    if (m.role !== "assistant" || !m.startedAt) return m;
                    const thinkingFull = (m.thinkingText ?? "").length;
                    const contentFull = (m.content ?? "").length;
                    const tRev = m.thinkingRevealed ?? 0;
                    const cRev = m.contentRevealed ?? 0;

                    let newT = tRev;
                    let newC = cRev;

                    if (m.completedAt || m.failedAt) {
                        // Once a turn is settled, snap thinking to full
                        // immediately and let the content typewriter run.
                        newT = thinkingFull;
                        if (m.failedAt) {
                            newC = contentFull;
                        } else if (cRev < contentFull) {
                            const step = Math.max(1, Math.round(CONTENT_CHARS_PER_SEC * elapsed / 1000));
                            newC = Math.min(contentFull, cRev + step);
                        }
                    } else if (tRev < thinkingFull) {
                        const step = Math.max(1, Math.round(THINKING_CHARS_PER_SEC * elapsed / 1000));
                        newT = Math.min(thinkingFull, tRev + step);
                    }

                    if (newT !== tRev || newC !== cRev) {
                        changed = true;
                        return { ...m, thinkingRevealed: newT, contentRevealed: newC };
                    }
                    return m;
                });
                return changed ? next : prev;
            });
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, []);

    // ============================================================
    // Phase 16 Task B — login restore on mount.
    // ============================================================
    // Hits /api/session/restore once. If the response carries a parsed
    // DPR, the page skips onboarding entirely and lands the student
    // back in their last conversation. Restored chat messages re-
    // populate `messages[]` (replacing the WELCOME bubble) so the
    // pending-mutation confirm buttons / tool-trace pills the student
    // saw last session render again. When auth is missing or no DPR
    // is stored we fall through to the existing onboarding flow.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch("/api/session/restore", { credentials: "same-origin" });
                if (!res.ok) return; // 401 (anonymous) or transient — skip silently
                const data = await res.json() as {
                    profile: unknown | null;
                    dpr: unknown | null;
                    forwardSchedule: ForwardSchedule | null;
                    studentDraftPlan: ForwardSchedule | null;
                    schedulePreferences: unknown | null;
                    chatMessages: ChatMessageRecord[];
                };
                if (cancelled) return;
                if (!data.dpr || !data.profile) {
                    // New student (or pre-Phase-16 data): existing
                    // onboarding flow handles them.
                    return;
                }
                // ---- Hydrate full session ----
                // Drop into the post-onboarding state machine immediately.
                setOnboardingStep("complete");
                // The v2 route requires `parsedData.kind === "dpr"`. We
                // wrap the restored DPR in the same discriminated shape
                // the live onboarding flow produces.
                setParsedData({ kind: "dpr", report: data.dpr });
                // Hydrate visa status from the persisted profile so the
                // v2 route's per-turn body carries the right value
                // (the profile is the source of truth, but the v2
                // request shape still passes visaStatus separately).
                const restoredProfile = data.profile as { visaStatus?: string; homeSchool?: string };
                if (restoredProfile.visaStatus === "f1" || restoredProfile.visaStatus === "domestic") {
                    setVisaStatus(restoredProfile.visaStatus);
                }
                // E5.2 — hydrate the persisted home school so subsequent
                // chat turns thread `body.homeSchool` (the confirmed value,
                // not a re-derivation). Skip the school-agnostic "unknown"
                // sentinel so we never send it as a confirmed school.
                if (restoredProfile.homeSchool && restoredProfile.homeSchool !== "unknown") {
                    setHomeSchool(restoredProfile.homeSchool);
                }
                // Hydrate graduation target from the restored schedule
                // when present; the v2 route uses it to populate the
                // system prompt's "graduating in" hint.
                const sched = data.forwardSchedule ?? data.studentDraftPlan;
                if (sched?.graduationTerm) {
                    setGraduationTarget(sched.graduationTerm);
                }
                // Hydrate the schedule slot per Decision #32 — the
                // restore route routes draft plans to studentDraftPlan
                // and valid plans to forwardSchedule. The sidebar reads
                // `forwardSchedule` for the live render; surface either
                // (the sidebar's 4-state banner keys off `state`).
                if (data.forwardSchedule) {
                    planStore.setForwardSchedule(data.forwardSchedule);
                } else if (data.studentDraftPlan) {
                    planStore.setForwardSchedule(data.studentDraftPlan);
                }
                // Hydrate restored preferences so the sidebar can
                // render freeze indicators on Lock-toggle UI without
                // waiting for the next /api/plan/confirm round-trip.
                if (data.schedulePreferences) {
                    planStore.setSchedulePreferences(data.schedulePreferences as SchedulePreferences);
                }
                // ---- Replay chat history ----
                if (data.chatMessages.length > 0) {
                    const restored: Message[] = data.chatMessages.map((m, i) => {
                        // System messages (rare) get rendered as
                        // assistant bubbles so the layout stays clean.
                        const role: "user" | "assistant" = m.role === "user" ? "user" : "assistant";
                        const id = `restored-${i}-${m.createdAt}`;
                        const tool: ToolStatus[] = (m.toolInvocations ?? []).map((t: ToolInvocation) => ({
                            toolName: t.toolName,
                            // Past-tense state — these turns already
                            // settled. error vs done is derived from
                            // the invocation's `error` field.
                            state: t.error ? ("error" as const) : ("done" as const),
                            ...(t.summary !== undefined ? { summary: t.summary } : {}),
                            ...(t.error?.message !== undefined ? { error: t.error.message } : {}),
                        }));
                        const created = Date.parse(m.createdAt);
                        const ts = Number.isFinite(created) ? created : Date.now();
                        const msg: Message = {
                            id,
                            role,
                            content: m.content,
                            timestamp: new Date(ts),
                        };
                        if (tool.length > 0) msg.toolStatuses = tool;
                        if (m.validatorViolations && m.validatorViolations.length > 0) {
                            msg.validatorViolations = m.validatorViolations.map((v) => ({
                                kind: v.kind,
                                detail: v.detail,
                                ...(v.caveatId ? { caveatId: v.caveatId } : {}),
                            }));
                        }
                        if (m.pendingMutationId) msg.pendingMutationId = m.pendingMutationId;
                        if (role === "assistant") {
                            // Mark as already settled so the typewriter
                            // doesn't re-stream the restored content.
                            msg.startedAt = ts;
                            msg.completedAt = ts;
                            if (m.thinkingText) {
                                msg.thinkingText = m.thinkingText;
                                msg.thinkingRevealed = m.thinkingText.length;
                                msg.hasRealThinking = true;
                            }
                            msg.contentRevealed = m.content.length;
                        }
                        return msg;
                    });
                    setMessages(restored);
                    // Scroll past the restored history.
                    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "auto" }), 50);
                }
            } catch (err) {
                // A failed restore must NOT break the page — fall back
                // to the existing onboarding flow.
                console.error("[chat page] /api/session/restore failed:", err);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const addMessage = (role: "user" | "assistant", content: string): Message => {
        const msg: Message = {
            id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
            role,
            content,
            timestamp: new Date(),
        };
        setMessages(prev => [...prev, msg]);
        setTimeout(scrollToBottom, 100);
        return msg;
    };

    const updateMessage = (id: string, patch: Partial<Message>) => {
        setMessages(prev => prev.map(m => (m.id === id ? { ...m, ...patch } : m)));
    };

    /**
     * Phase 6.5 P-1 cutover: post-onboarding messages flow through the
     * SSE v2 endpoint (`/api/chat/v2`). Tool invocations and validator
     * blocks are surfaced inline. Onboarding turns continue to use the
     * legacy `/api/chat` JSON route per Option B (the agent loop
     * doesn't replicate the onboarding state machine).
     */
    /**
     * Optional per-call overrides for the profile fields `handleSendV2`
     * normally reads from React state. Used by the wizard cutover
     * (`handleWizardReachPlan`) to defeat the STALE-CLOSURE race (I2):
     * the wizard calls `setHomeSchool`/`setVisaStatus`/`setGraduationTarget`
     * and then injects its turns in the SAME tick, but React state is
     * async, so the injected `handleSendV2` would otherwise read the
     * PRE-SEED closure values — the first wizard turn would go out WITHOUT
     * the just-confirmed home school, risking the silent-CAS outcome the
     * wizard exists to prevent. Threading the seed EXPLICITLY here makes
     * the very first injected turn carry the confirmed homeSchool.
     */
    type SendSeed = {
        homeSchool?: string | null;
        visaStatus?: string | null;
        graduationTarget?: string | null;
        // F1 fix — the just-uploaded DPR, wrapped in the SAME
        // discriminated `{ kind: "dpr"; report }` shape the page
        // `parsedData` state uses. Threaded so a SAME-TICK wizard turn
        // carries the DPR before `setParsedData` has flushed (the I2
        // stale-closure race extends to the DPR itself — without this the
        // first wizard preference turn would POST `parsedData: null` and
        // fall to the v1 route).
        parsedData?: ParsedTranscript;
    };

    const handleSendV2 = async (userText: string, seed?: SendSeed) => {
        const recentHistory = messages
            .filter(m => m.id !== "welcome")
            .slice(-10)
            .map(m => ({ role: m.role, content: m.content }));

        // Seed overrides win over the (possibly not-yet-flushed) closure
        // state so a same-tick wizard injection sends the confirmed values.
        const effectiveHomeSchool = seed?.homeSchool ?? homeSchool;
        const effectiveVisaStatus = seed?.visaStatus ?? visaStatus;
        const effectiveGraduationTarget = seed?.graduationTarget ?? graduationTarget;
        // F1 fix — same stale-closure dodge for the DPR itself. The wizard
        // sets `parsedData` and injects its preference turns in the SAME
        // tick; React state is async, so the injected turn would otherwise
        // read the PRE-UPLOAD closure value (null). Threading the DPR
        // through the seed makes the first wizard turn carry it.
        const effectiveParsedData = seed?.parsedData ?? parsedData;

        // Pre-create the assistant bubble so tokens stream INTO it.
        const assistant = addMessage("assistant", "");
        updateMessage(assistant.id, {
            startedAt: Date.now(),
            thinkingText: "",
            thinkingRevealed: 0,
            contentRevealed: 0,
        });
        const toolStatuses: ToolStatus[] = [];

        for await (const ev of streamChatV2({
            message: userText,
            parsedData: effectiveParsedData,
            visaStatus: effectiveVisaStatus,
            graduationTarget: effectiveGraduationTarget,
            history: recentHistory,
            userId: getOrCreateClientId(),
            // E5.2 — thread the onboarding-confirmed home school. Spread in
            // ONLY when set so an unconfirmed student never sends a (silent
            // CAS) value; the v2 route maps this → homeSchoolOverride.
            ...(effectiveHomeSchool ? { homeSchool: effectiveHomeSchool } : {}),
        })) {
            applyEvent(ev, assistant.id, toolStatuses);
        }
    };

    const applyEvent = (ev: ChatV2Event, assistantId: string, toolStatuses: ToolStatus[]) => {
        switch (ev.kind) {
            case "tool_invocation_start": {
                toolStatuses.push({ toolName: ev.toolName, state: "running" });
                const sentence = getThoughtSentence(ev.toolName);
                setMessages(prev => prev.map(m => {
                    if (m.id !== assistantId) return m;
                    // When the real model is producing a chain-of-thought,
                    // the synthesized tool-sentence narration would just
                    // duplicate / contradict the model's words. Skip it.
                    if (m.hasRealThinking) {
                        return { ...m, toolStatuses: [...toolStatuses] };
                    }
                    // Drop a duplicate sentence (e.g. the model called
                    // `search_policy` twice in a row — render the canned
                    // sentence ONCE, not twice) and connect distinct
                    // sentences with a single space so they read as one
                    // flowing paragraph instead of a bullet list of
                    // identical lines.
                    const existing = m.thinkingText ?? "";
                    if (existing.endsWith(sentence)) {
                        return { ...m, toolStatuses: [...toolStatuses] };
                    }
                    return {
                        ...m,
                        toolStatuses: [...toolStatuses],
                        thinkingText: existing + (existing ? " " : "") + sentence,
                    };
                }));
                break;
            }
            case "tool_invocation_done": {
                const idx = toolStatuses.findIndex(t => t.toolName === ev.toolName && t.state === "running");
                if (idx >= 0) {
                    toolStatuses[idx] = {
                        toolName: ev.toolName,
                        state: ev.error ? "error" : "done",
                        summary: ev.summary,
                        error: ev.error,
                    };
                }
                const pendingId = ev.toolName === "update_profile" ? extractPendingMutationId(ev.summary) : null;
                updateMessage(assistantId, {
                    toolStatuses: [...toolStatuses],
                    ...(pendingId ? { pendingMutationId: pendingId } : {}),
                });
                break;
            }
            case "token":
                // Block-streaming v2 emits the full text as a single
                // token event. The handler still APPENDS rather than
                // overwriting so a future intra-token streaming
                // upgrade is drop-in compatible.
                setMessages(prev => prev.map(m => m.id === assistantId
                    ? { ...m, content: (m.content || "") + ev.text }
                    : m));
                setTimeout(scrollToBottom, 50);
                break;
            case "thinking":
                setMessages(prev => prev.map(m => {
                    if (m.id !== assistantId) return m;
                    if (!m.hasRealThinking) {
                        // Phase 13 §8c — first real thinking event. The
                        // synthesized tool-sentence narration (if any) was
                        // a fallback; real reasoning replaces it. Clear and
                        // start fresh so the user doesn't see both.
                        return {
                            ...m,
                            thinkingText: ev.text,
                            thinkingRevealed: 0, // restart the typewriter on the new text
                            hasRealThinking: true,
                        };
                    }
                    return {
                        ...m,
                        thinkingText: (m.thinkingText ?? "") + ev.text,
                        hasRealThinking: true,
                    };
                }));
                break;
            case "forward_schedule_update":
                planStore.setForwardSchedule(ev.schedule);
                break;
            case "whatif_audit_request": {
                // H4.2b-3 — the agent offered a Branch-A "explore precisely"
                // path this turn (hypothetical PROGRAM change). Inject a
                // WhatIfUploadCard into the thread so the student can upload
                // their Albert What-If audit → a read-only 🔍 what-if
                // scenario. No store/DPR write happens here; the upload
                // round-trip is owned by handleWhatIfAuditUpload.
                const uploadCardId = Date.now().toString() + Math.random().toString(36).slice(2, 6);
                setMessages(prev => [
                    ...prev,
                    {
                        id: uploadCardId,
                        role: "assistant",
                        content: "",
                        timestamp: new Date(),
                        kind: "whatif_upload_card",
                        whatifUpload: { hypotheticalProgram: ev.hypotheticalProgram },
                    },
                ]);
                setTimeout(scrollToBottom, 50);
                break;
            }
            case "forward_materialization_update":
                // Phase 15 Task 8 — `materialize_sections` produced a
                // result this turn. Hold it in state so the sidebar
                // can switch the IMMEDIATE term to the Sections view
                // (or render a partial/unavailable banner). Cleared
                // alongside `forwardSchedule` when a new chat starts.
                planStore.setForwardMaterialization(ev.result);
                break;
            case "validator_block":
                updateMessage(assistantId, {
                    validatorViolations: ev.violations.map(v => ({
                        kind: v.kind,
                        detail: v.detail,
                        ...(v.caveatId ? { caveatId: v.caveatId } : {}),
                    })),
                });
                break;
            case "done":
                // Final reconciliation — the server's `finalText` is
                // authoritative. For block-streaming this matches the
                // accumulated tokens; for future intra-token streaming
                // this guards against partial-chunk artifacts.
                updateMessage(assistantId, { content: ev.finalText, completedAt: Date.now() });
                break;
            case "error": {
                // Don't leak raw exception text (file paths, internal
                // identifiers, etc.) to the student. Log the detail so
                // the operator can correlate via /admin/observability;
                // show a generic but useful copy in-chat.
                console.error("[chat v2 error]", ev.message);
                const friendly =
                    `Something went wrong on our side handling that turn. ` +
                    `Try resending — if it keeps happening, email the operator at edoardo.mongardi18@gmail.com.`;
                const existing = assistantId ? messages.find(m => m.id === assistantId)?.content : "";
                updateMessage(assistantId, {
                    content: existing && existing.length > 0 ? existing : friendly,
                    failedAt: Date.now(),
                });
                break;
            }
        }
    };

    /** Legacy v1 path — kept for onboarding turns. */
    const handleSendV1 = async (userText: string) => {
        const recentHistory = messages
            .filter(m => m.id !== "welcome")
            .slice(-10)
            .map(m => ({ role: m.role, content: m.content }));
        const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: userText,
                onboardingStep,
                parsedData,
                visaStatus,
                graduationTarget,
                history: recentHistory,
            }),
        });
        const data = await res.json();
        addMessage("assistant", data.message);
        if (data.onboardingStep) setOnboardingStep(data.onboardingStep);
        if (data.visaStatus) setVisaStatus(data.visaStatus);
        if (data.graduationTarget) setGraduationTarget(data.graduationTarget);
    };

    const handleSend = async () => {
        const text = input.trim();
        if (!text || isLoading) return;

        setInput("");
        addMessage("user", text);
        setIsLoading(true);

        try {
            // Onboarding turns and pre-transcript chitchat → legacy v1.
            // Post-onboarding (parsedData present + step=complete) → v2 SSE.
            const useV2 = onboardingStep === "complete" && parsedData;
            if (useV2) {
                await handleSendV2(text);
            } else {
                await handleSendV1(text);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Sorry, something went wrong. Please try again.";
            addMessage("assistant", msg);
        } finally {
            setIsLoading(false);
            inputRef.current?.focus();
        }
    };

    /**
     * Phase 14 Task 10 — Load-style proposal.
     * Injects a user-visible chat message asking the agent to call
     * `propose_plan_change` with the requested load style. The agent's
     * tool-use behavior handles the round-trip from here.
     */
    const handleProposeLoadStyle = async (style: "balanced" | "frontload" | "backload") => {
        if (isLoading) return;
        const text = `Please propose a ${style} load style for my schedule — call propose_plan_change with loadStyle="${style}".`;
        addMessage("user", text);
        setIsLoading(true);
        try {
            await handleSendV2(text);
        } catch (err) {
            addMessage("assistant", err instanceof Error ? err.message : "Could not propose load style change.");
        } finally {
            setIsLoading(false);
        }
    };

    /**
     * Phase 4 Task E5.5 — undeclared → INTENDED-major RAG-preview (Lane B,
     * hedged). When an UNDECLARED wizard student names an intended major and
     * chooses "Preview by name", we inject `buildIntendedMajorPreviewTurn`
     * through the SAME `addMessage → handleSendV2` rail every client edit
     * uses — EXACTLY mirroring `handleProposeLoadStyle`. The turn is HONESTLY
     * framed as a PREVIEW to verify with the adviser / NOT a confirmed plan /
     * with a confidence ask, so the agent answers through its grounded RAG
     * (`what_if_audit` / `search_policy`) and the §11 / D4.4 confidence +
     * adviser rail FIRES — the engine owns the hedge; the wizard invents NO
     * requirement and ships NO unqualified plan. School-AGNOSTIC: a non-CAS
     * (NYU Shanghai / Abu Dhabi) intended major previews + hedges identically.
     * The other undeclared arm — uploading an Albert What-If audit — reuses
     * the EXISTING `/api/onboard` upload (a What-If report parses end-to-end
     * via `parseDpr` into Lane A); no new route, no new requirement logic.
     */
    const handleIntendedMajorPreview = async (intendedMajor: string) => {
        if (isLoading) return;
        const major = intendedMajor.trim();
        if (!major) return; // nothing named — no-op.
        const text = buildIntendedMajorPreviewTurn(major);
        addMessage("user", text);
        setIsLoading(true);
        try {
            await handleSendV2(text);
        } catch (err) {
            addMessage(
                "assistant",
                err instanceof Error ? err.message : "Could not preview that intended major.",
            );
        } finally {
            setIsLoading(false);
        }
    };

    /**
     * Phase 14 Task 10 — Slot-level change proposal.
     * Injects a user-visible chat message describing the desired
     * slot mutation. The agent's tool-use behavior routes the call
     * to `propose_plan_change` with appropriate args.
     */
    const handleProposeSlotChange = async (
        slot: import("@nyupath/shared").ScheduleSlot,
        action: "lock" | "replace" | "drop" | "pin",
    ) => {
        if (isLoading) return;
        const slotId =
            slot.kind === "specific_planned" || slot.kind === "completed" || slot.kind === "in_progress"
                ? slot.courseId
                : `placeholder(${slot.category})`;
        const actionText: Record<string, string> = {
            lock: `lock the slot for ${slotId} as-is`,
            replace: `replace the slot for ${slotId} with a different course`,
            drop: `drop the slot for ${slotId}`,
            pin: `pin ${slotId} to a different term`,
        };
        const text = `Please ${actionText[action]} — call propose_plan_change with the appropriate args for this change.`;
        addMessage("user", text);
        setIsLoading(true);
        try {
            await handleSendV2(text);
        } catch (err) {
            addMessage("assistant", err instanceof Error ? err.message : "Could not propose slot change.");
        } finally {
            setIsLoading(false);
        }
    };

    /**
     * Phase 4 Task E4.1 — slot ⋯ "Explain why" shortcut.
     * Builds a SCOPED natural-language question naming the course code
     * (or placeholder category) + the human term label, injects it as a
     * user-visible chat message, then drops into the normal agent loop —
     * EXACTLY mirroring `handleProposeSlotChange` (addMessage →
     * handleSendV2). The agent composes the Phase-3 introspection tools
     * (`view_forward_plan`, `probe_counterfactual`, the trade-off diff)
     * to answer; there is NO new explanation route (design §2.6).
     */
    const handleExplainSlot = async (
        slot: import("@nyupath/shared").ScheduleSlot,
        term: string,
    ) => {
        if (isLoading) return;
        const text = buildExplainSlotQuestion(slot, term);
        addMessage("user", text);
        setIsLoading(true);
        try {
            await handleSendV2(text);
        } catch (err) {
            addMessage("assistant", err instanceof Error ? err.message : "Could not explain that slot.");
        } finally {
            setIsLoading(false);
        }
    };

    /**
     * Phase 4 Task E4.1 — term-header "Explain this term" shortcut.
     * Same injection contract as `handleExplainSlot`, scoped to a whole
     * term (workload-included).
     */
    const handleExplainTerm = async (term: string) => {
        if (isLoading) return;
        const text = buildExplainTermQuestion(term);
        addMessage("user", text);
        setIsLoading(true);
        try {
            await handleSendV2(text);
        } catch (err) {
            addMessage("assistant", err instanceof Error ? err.message : "Could not explain that term.");
        } finally {
            setIsLoading(false);
        }
    };

    /**
     * Phase 4 Task E5.4 — apply the onboarding wizard's Goals +
     * Preferences onto the EXISTING Phase-3 preference ladder.
     *
     * TRANSPORT (the binding constraint): this imports NO engine
     * internals and adds NO `/api/preferences/*` route. It reaches the
     * ladder the SAME way every other client pref edit does — by
     * INJECTING a chat turn that asks the agent to call
     * `propose_plan_change` / `confirm_plan_change`, EXACTLY mirroring
     * `handleProposeLoadStyle` (addMessage → handleSendV2). The agent
     * loop compiles each turn (free-text → addSoftObjective; workload
     * distribution (frontload/backload) → loadStyleOverride; the
     * summer/J-term/study-abroad/honors toggles → addSoftObjective —
     * the SchedulingPreferences schema has no field for them, so they
     * ride the generic SOFT rail) and applies it via
     * `applyMutationsToPreferences`, then persists.
     *
     * `buildPreferenceTurns` returns ONE turn per non-default preference
     * (empty when the student skipped everything). We inject each
     * SEQUENTIALLY — awaiting each so the agent's propose/confirm loop
     * applies them one at a time (a later turn never races an earlier
     * one). Wired via the wizard's `onReachPlan` callback.
     *
     * `seed` (I2) threads the just-confirmed profile (home school / visa /
     * grad term) into EVERY injected turn so the FIRST turn already carries
     * the confirmed home school despite React state being async — see
     * `handleSendV2`'s SendSeed doc. PARTIAL-FAILURE (I5): each turn's
     * injection is wrapped in its own try/catch so one throwing turn never
     * silently drops the rest — we surface a brief note and continue.
     */
    const handleApplyWizardPreferences = async (values: WizardValues, seed?: SendSeed) => {
        if (isLoading) return;
        const turns = buildPreferenceTurns(values);
        if (turns.length === 0) return; // all defaults — nothing to apply.
        setIsLoading(true);
        try {
            for (const text of turns) {
                try {
                    addMessage("user", text);
                    await handleSendV2(text, seed);
                } catch (err) {
                    // I5 — one failing turn must not drop the remaining
                    // preferences. Surface a brief note and keep going.
                    addMessage(
                        "assistant",
                        err instanceof Error
                            ? `Couldn't apply one preference (${err.message}); continuing with the rest.`
                            : "Couldn't apply one preference; continuing with the rest.",
                    );
                }
            }
        } finally {
            setIsLoading(false);
        }
    };

    /**
     * Phase 4 Task E5.4 + F1 — the wizard's `onReachPlan` consumer (the
     * cutover seam, now LIVE: the wizard is mounted as the `awaiting_dpr`
     * onboarding surface — see the `<OnboardingWizard … />` mount below).
     * When the onboarding wizard reaches its terminal "plan" step it hands
     * its collected `values` + the parsed DPR (`dpr`, the wizard's internal
     * `parsedDpr` — `null` when the student never uploaded) here. We:
     *   0. (F1 fix) COMPLETE onboarding when a DPR is present —
     *      `setParsedData({ kind: "dpr", report: dpr })` +
     *      `setOnboardingStep("complete")` (mirroring the session-restore
     *      path, page.tsx:295/:299) so EVERY future chat turn routes through
     *      the v2 agent loop and the sidebar hydrates. When the DPR is
     *      ABSENT we do NOT complete (no DPR → no personalized plan): we
     *      surface the upload-needed prompt and stay `awaiting_dpr`,
     *      fabricating no plan;
     *   1. seed the EXISTING chat-page profile state from the wizard's
     *      Goals (home school → body.homeSchool; F-1/domestic →
     *      body.visaStatus; grad term → body.graduationTarget) using the
     *      SAME setters the session-restore path uses — no duplicate
     *      persistence, no new route; and
     *   2. apply the Goals + Preferences onto the Phase-3 ladder via
     *      `handleApplyWizardPreferences` (the chat-turn injection rail),
     *      threading the DPR + profile through the seed so the FIRST
     *      injected turn carries them despite React state being async (I2).
     * `handleIntendedMajorPreview` (E5.5) is the matching ready callback for
     * an UNDECLARED student's intended-major RAG-preview arm.
     */
    const handleWizardReachPlan = async (values: WizardValues, dpr?: DegreeProgressReport | null) => {
        // F1 fix — COMPLETE onboarding on handoff. Without a DPR we cannot
        // build a personalized plan (core philosophy: no DPR → no
        // personalized plan), so we must NOT flip to "complete" — that would
        // strand the student on a v2 path with empty `parsedData` and an
        // empty sidebar. Surface the upload-needed prompt and stay in
        // `awaiting_dpr` (the wizard/upload remains available). We fabricate
        // NO plan.
        if (!dpr) {
            addMessage(
                "assistant",
                "I need your Degree Progress Report to build your plan — please upload it (📎 / drag-and-drop).",
            );
            return;
        }
        // DPR present → complete onboarding so EVERY future chat turn routes
        // through the v2 agent loop (the `useV2` gate is
        // `onboardingStep === "complete" && parsedData`). Mirrors the
        // session-restore path (page.tsx:295/:299) — same setters, same
        // `{ kind: "dpr", report }` shape, no duplicate persistence, no new
        // route. This is the bug fix: the prior code ignored `dpr` and never
        // set EITHER, so the handoff silently dropped the student back onto
        // the legacy v1 route with a null `parsedData` (empty sidebar).
        setParsedData({ kind: "dpr", report: dpr });
        setOnboardingStep("complete");
        // Seed the home school ONLY when the student chose one — never
        // silently CAS (an empty value stays null → field omitted).
        if (values.homeSchool) setHomeSchool(values.homeSchool);
        if (values.visa) setVisaStatus(values.visa);
        if (values.gradTerm) setGraduationTarget(values.gradTerm);
        // I2 (stale-closure): the setters above are async — they have NOT
        // flushed by the time the preference turns inject in this same tick.
        // Thread the confirmed values EXPLICITLY so the FIRST injected turn
        // already carries the just-confirmed home school (and visa / grad
        // term) AND the just-uploaded DPR, instead of the pre-seed closure
        // values handleSendV2 would otherwise read. homeSchool falls through
        // ONLY when chosen — never silently CAS.
        const seed: SendSeed = {
            parsedData: { kind: "dpr", report: dpr },
            ...(values.homeSchool ? { homeSchool: values.homeSchool } : {}),
            ...(values.visa ? { visaStatus: values.visa } : {}),
            ...(values.gradTerm ? { graduationTarget: values.gradTerm } : {}),
        };
        await handleApplyWizardPreferences(values, seed);
    };

    /**
     * Two-step profile-update confirm affordance (§7.2). Sends a
     * follow-up user message that asks the agent to invoke
     * `confirm_profile_update` with the pending id. The agent's
     * system prompt + tool schema route this through correctly.
     */
    const handleConfirmPending = async (pendingMutationId: string) => {
        if (isLoading) return;
        const text = `Yes, please apply the pending profile update (pendingMutationId="${pendingMutationId}").`;
        addMessage("user", text);
        setIsLoading(true);
        try {
            await handleSendV2(text);
        } catch (err) {
            addMessage("assistant", err instanceof Error ? err.message : "Could not confirm the update.");
        } finally {
            setIsLoading(false);
        }
    };

    /**
     * Phase 15 Task 8 — section-combination confirm affordance (§7.2's
     * two-step contract for `materialize_sections` →
     * `confirm_section_combination`). The sidebar invokes this when the
     * student clicks "Apply combination" on a picked combination tab.
     * Mirrors `handleConfirmPending` exactly: inject a chat-visible
     * user message naming the staged proposalId, then drop into the
     * agent's tool-use loop.
     */
    const handleConfirmSectionCombination = async (proposalId: string) => {
        if (isLoading) return;
        const text =
            `Yes, please apply section combination ${proposalId} — call ` +
            `confirm_section_combination with proposalId="${proposalId}".`;
        addMessage("user", text);
        setIsLoading(true);
        try {
            await handleSendV2(text);
        } catch (err) {
            addMessage("assistant", err instanceof Error ? err.message : "Could not confirm the section combination.");
        } finally {
            setIsLoading(false);
        }
    };

    // ============================================================
    // Phase 17 Task D follow-up — plan_action_bubble lifecycle
    // ============================================================
    // Sidebar verbs (Add / Swap / Drop / Lock / Move) call deterministic
    // /api/plan/<verb> routes; the sidebar surfaces the route response
    // to the page via `onPlanActionResult`. The page injects ONE
    // `plan_action_bubble` Message into the chat thread for non-clean
    // outcomes (clean applies stay silent — the sidebar's own state
    // re-render is the only feedback). The bubble carries Confirm +
    // Keep-as-is buttons (and Override-anyway for soft refusals); a
    // background polish stream (gated on
    // NEXT_PUBLIC_PLAN_CHANGE_LLM_POLISH=1) replaces the deterministic
    // template text once Anthropic Haiku returns; Stage 2 streams
    // FOSE-section enrichment per future term inside the data window.

    /** Patch a single Message by id while leaving the rest untouched. */
    const patchMessage = useCallback((id: string, patch: Partial<Message>) => {
        setMessages(prev => prev.map(m => (m.id === id ? { ...m, ...patch } : m)));
    }, []);

    /**
     * Patch the bubble payload of a single Message — convenience
     * wrapper around `patchMessage` so reducers don't have to
     * spread the full Message wrapper themselves.
     */
    const patchBubble = useCallback((messageId: string, mutate: (b: PlanActionBubbleState) => PlanActionBubbleState) => {
        setMessages(prev => prev.map(m => {
            if (m.id !== messageId) return m;
            if (!m.bubble) return m;
            const next = mutate(m.bubble);
            if (next === m.bubble) return m;
            return { ...m, bubble: next };
        }));
    }, []);

    /**
     * Per-bubble AbortController registry. When the user clicks
     * Confirm / Keep-as-is / Override-anyway we want to abort any
     * in-flight polish + Stage 2 streams so we don't burn Anthropic +
     * FOSE tokens after the bubble is resolved. Keyed by messageId.
     *
     * Stored as a ref (not state) because abort signaling is an
     * imperative side-effect, not a render-driving value.
     */
    const bubbleAbortersRef = useRef<Map<string, AbortController>>(new Map());

    /**
     * Spawn the polish + Stage 2 fetches for a freshly-injected bubble.
     * Both fetches are fire-and-forget — they update the bubble via
     * the patchBubble reducer as events stream in.
     *
     * Each spawn registers an AbortController on `bubbleAbortersRef`
     * so the bubble's resolution handlers can stop the streams cleanly.
     * Stage 2 is gated on `bubble.kind !== "hard_refusal"` because a
     * hard refusal already failed structural validation — surfacing
     * "✓ Open sections exist" for terms we just refused to plan into
     * is confusing UX.
     *
     * Phase 4 Task E3.4 — the FEASIBLE path (clean + trade-offs) no
     * longer mints a chat bubble (the canvas review card is its sole
     * surface), so the ONLY live callers here are now the
     * `soft_refusal` / `hard_refusal` (`feasible:false`) bubbles. The
     * `kind !== "clean"` polish gate + the `kind !== "hard_refusal"`
     * Stage-2 gate are therefore partially vestigial. Surfacing the
     * feasible-path Stage-2 FOSE "open sections" signal on the review
     * card is deliberately PARKED for Phase 5 (live-data UI — design §9
     * / plan Out-of-scope line 47); the review card shows the
     * deterministic engine `consequences` instead (no-invention).
     */
    const spawnBubbleEnrichers = useCallback((messageId: string, bubble: PlanActionBubbleState) => {
        // Reuse-or-create the AbortController for this bubble.
        let aborter = bubbleAbortersRef.current.get(messageId);
        if (!aborter) {
            aborter = new AbortController();
            bubbleAbortersRef.current.set(messageId, aborter);
        }
        const { signal } = aborter;

        // ---- LLM polish (env-flag gated, non-clean only) ----
        const polishEnabled = process.env.NEXT_PUBLIC_PLAN_CHANGE_LLM_POLISH === "1";
        if (polishEnabled && bubble.kind !== "clean") {
            (async () => {
                try {
                    for await (const ev of streamPlanActionPolish(
                        {
                            slotKey: bubble.slotKey,
                            templateText: bubble.text,
                        },
                        { signal },
                    )) {
                        if (signal.aborted) return;
                        patchBubble(messageId, (b) => applyPolishEvent(b, ev));
                    }
                } catch (err) {
                    if (signal.aborted) return; // expected on user-confirm path
                    // Best-effort — keep the deterministic template
                    // intact on transport failure.
                    console.error("[plan_action_bubble] polish stream failed:", err);
                }
            })();
        }

        // ---- Stage 2 enrichment (non-empty futureTerms; not hard refusals) ----
        // Hard refusals had Stage 1 reject the structural change, so
        // surfacing per-term FOSE-section signals for the rejected
        // terms would mislead the user. Only fire Stage 2 when there
        // is something the user could actually choose to confirm.
        if (bubble.futureTerms.length > 0 && bubble.kind !== "hard_refusal") {
            (async () => {
                try {
                    for await (const ev of streamPlanActionStage2(
                        {
                            slotKey: bubble.slotKey,
                            futureTerms: bubble.futureTerms,
                        },
                        { signal },
                    )) {
                        if (signal.aborted) return;
                        patchBubble(messageId, (b) => applyStage2Event(b, ev));
                    }
                } catch (err) {
                    if (signal.aborted) return;
                    console.error("[plan_action_bubble] stage2 stream failed:", err);
                }
            })();
        }
    }, [patchBubble]);

    /**
     * Abort any in-flight polish + Stage 2 streams for a bubble. Called
     * by all three resolution handlers (Confirm / Keep-as-is /
     * Override-anyway) so the network round-trips stop the moment the
     * user picks an action — no orphan token spend.
     */
    const abortBubbleEnrichers = useCallback((messageId: string): void => {
        const aborter = bubbleAbortersRef.current.get(messageId);
        if (aborter) {
            aborter.abort();
            bubbleAbortersRef.current.delete(messageId);
        }
    }, []);

    /**
     * Sidebar callback wired through `<ScheduleSidebar onPlanActionResult>`.
     * Decides whether to inject a bubble based on the route response's
     * shape (clean → silent; trade-offs / refusal → bubble).
     */
    const handlePlanActionResult = useCallback((
        verb: "add" | "swap" | "drop" | "lock" | "move",
        result: PlanActionResult<PlanActionRouteResponse>,
    ): void => {
        if (!result.ok) {
            // Route layer surfaced an error (401/409/500/etc). The
            // sidebar already logs to the console; surface a brief
            // assistant-bubble so the user sees something happened.
            const friendly = result.status === 0
                ? `Network error during ${verb}: ${result.error}`
                : `Plan-${verb} failed (${result.status}): ${result.error}`;
            const failureMsg: Message = {
                id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
                role: "assistant",
                content: friendly,
                timestamp: new Date(),
            };
            setMessages(prev => [...prev, failureMsg]);
            setTimeout(scrollToBottom, 50);
            return;
        }
        // Phase 4 Task E3.4 — drag/⋯ reconciliation. The per-course ⋯
        // menu is the SOLE edit input now (drag was removed), and EVERY
        // ⋯ verb PROPOSES — it stages the E3.1 canvas preview + E3.2
        // review card and applies ONLY on Confirm. The single pure
        // `planActionSurfaces` helper decides the THREE surfaces from the
        // engine's own verdict; there is NO `kind === "clean"` early
        // return any more (a clean result is no longer silently dropped —
        // it previews like every other feasible verb).
        //
        //   - feasible (clean OR trade-offs) + a proposed schedule → a
        //     PENDING violet preview (E3.1), the committed plan untouched,
        //     and any stale RED card cleared. NO chat bubble — the canvas
        //     review card is the sole surface (E3.4 bubble↔card dedup).
        //   - feasible === false → a RED invalid-proposal card (E3.3)
        //     naming the binding constraint(s) from the response's OWN
        //     fields, the committed plan byte-identical, any stale preview
        //     cleared. The chat bubble is ALSO minted (it carries
        //     Override-anyway / hard-refusal copy the red card doesn't).
        //
        // Either way the committed plan (planStore.forwardSchedule) is
        // NEVER mutated here — only Confirm commits.
        const surfaces = planActionSurfaces(result.data, verb);
        if (surfaces.invalidCard) {
            planStore.setInvalidProposal(surfaces.invalidCard);
            planStore.clearPendingPreview();
        } else if (surfaces.preview) {
            planStore.setPendingPreview(surfaces.preview);
            // A feasible preview supersedes any stale red card.
            planStore.clearInvalidProposal();
            // H4.2a — emit a ScheduleCard into the chat thread so the
            // student can open/compare the new proposed scenario from
            // the conversation (feasible path ONLY; invalid stays card-only).
            const activeSc = planStore.getActiveScenario();
            if (activeSc && activeSc.kind === "proposed") {
                const cardMsgId = Date.now().toString() + Math.random().toString(36).slice(2, 6);
                setMessages(prev => [...prev, buildScheduleCardMessage(activeSc, cardMsgId, new Date()) as Message]);
                setTimeout(scrollToBottom, 50);
            }
        }
        // E3.4 bubble↔card dedup — mint the chat bubble ONLY for the
        // feasible:false path (showBubble). The feasible path's sole
        // surface is the canvas review card (nothing is appended to the
        // chat thread → no scroll), which removes the double-surface +
        // the card→bubble stale-button bug entirely.
        if (!surfaces.showBubble) {
            return;
        }
        const bubble = initBubbleState(result.data);
        const id = `bubble-${result.data.pendingMutationId}`;
        const msg: Message = {
            id,
            role: "assistant",
            content: bubble.text,
            timestamp: new Date(),
            kind: "plan_action_bubble",
            bubble,
            bubbleVerb: verb,
            bubbleResolved: false,
        };
        setMessages(prev => [...prev, msg]);
        setTimeout(scrollToBottom, 50);
        spawnBubbleEnrichers(id, bubble);
    }, [spawnBubbleEnrichers]);

    /**
     * Plan 35 G3.2 — a what-if-assumption result from the sidebar's per-IP-course
     * control (POST /api/plan/whatif). Mirrors `handlePlanActionResult`: stages
     * the violet canvas preview + the review card, here carrying the
     * `whatIfAssumption` marker so the card shows the "assumes you withdraw / take
     * pass-fail X — not yet on your DPR; verify" badge. The committed plan is
     * NEVER mutated; Confirm reuses the normal pendingMutationId round-trip and
     * the engine persists ONLY the forward_schedule, never the DPR (R1).
     */
    const handleWhatIfResult = useCallback((
        result: PlanActionResult<WhatIfAssumptionRouteResponse>,
    ): void => {
        if (!result.ok) {
            const friendly = result.status === 0
                ? `Network error during what-if: ${result.error}`
                : `What-if failed (${result.status}): ${result.error}`;
            setMessages(prev => [...prev, {
                id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
                role: "assistant",
                content: friendly,
                timestamp: new Date(),
            }]);
            setTimeout(scrollToBottom, 50);
            return;
        }
        // A what-if assumption is a feasible preview carrying the
        // whatIfAssumption marker → stage the preview + labeled review card.
        const surfaces = planActionSurfaces(result.data);
        if (surfaces.invalidCard) {
            planStore.setInvalidProposal(surfaces.invalidCard);
            planStore.clearPendingPreview();
        } else if (surfaces.preview) {
            planStore.setPendingPreview(surfaces.preview);
            planStore.clearInvalidProposal();
            // H4.2a — emit a ScheduleCard into the chat thread so the
            // student can open/compare the new what-if scenario from the
            // conversation (feasible path ONLY; invalid stays card-only).
            const activeSc = planStore.getActiveScenario();
            if (activeSc && activeSc.kind === "proposed") {
                const cardMsgId = Date.now().toString() + Math.random().toString(36).slice(2, 6);
                setMessages(prev => [...prev, buildScheduleCardMessage(activeSc, cardMsgId, new Date()) as Message]);
                setTimeout(scrollToBottom, 50);
            }
        }
    }, []);

    /** Confirm — apply the staged mutation. */
    const handleBubbleConfirm = useCallback(async (messageId: string, pendingMutationId: string): Promise<void> => {
        // Lock buttons immediately so a double-click can't double-submit.
        patchMessage(messageId, { bubbleResolved: true });
        // Abort any in-flight polish + Stage 2 streams — no point
        // burning Anthropic / FOSE tokens on a bubble the user already
        // resolved.
        abortBubbleEnrichers(messageId);
        try {
            const result = await planConfirm({ pendingMutationId });
            if (!result.ok) {
                // Re-enable buttons so the user can retry; surface a
                // brief inline note via patchMessage.
                patchMessage(messageId, {
                    bubbleResolved: false,
                    content: `Confirm failed (${result.status}): ${result.error}`,
                });
                return;
            }
            // Persist state — the sidebar reads forwardSchedule on the
            // next render. Keep the bubble in the resolved state so the
            // chat shows what just happened (buttons hidden).
            if (result.data.forwardSchedule) {
                planStore.setForwardSchedule(result.data.forwardSchedule);
            }
            // E3.1 — the proposal is now the committed plan; drop the
            // PENDING canvas overlay so the sidebar shows the committed
            // schedule (clear AFTER setForwardSchedule so there is no
            // flash of the pre-confirm plan).
            planStore.clearPendingPreview();
            patchMessage(messageId, {
                bubbleResolved: true,
                content: "✓ Applied.",
            });
        } catch (err) {
            patchMessage(messageId, {
                bubbleResolved: false,
                content: `Confirm failed: ${err instanceof Error ? err.message : String(err)}`,
            });
        }
    }, [patchMessage, abortBubbleEnrichers]);

    /**
     * H4.2b-3 — Branch-A "explore precisely" upload handler.
     *
     * POSTs the student's Albert What-If audit PDF (multipart field `dpr`,
     * matching the wizard's /api/onboard shape) to /api/whatif-audit. On
     * success, builds a READ-ONLY 🔍 what-if scenario from the response,
     * adds it to the workspace, emits a schedule_card into the chat, and
     * appends a narration message clearly framing it as a hypothetical
     * (NOT committed).
     *
     * R1: this NEVER calls /api/plan/confirm and NEVER writes parsed_dpr.
     * The scenario it builds has no pendingMutationId — it cannot be
     * confirmed/committed. We never log the file bytes or any PII.
     */
    const handleWhatIfAuditUpload = useCallback(
        async (file: File, cardMessageId: string): Promise<void> => {
            // Client-side PDF guard mirrors the wizard + the route.
            if (!file.name.toLowerCase().endsWith(".pdf")) {
                setWhatifUploadError(prev => ({
                    ...prev,
                    [cardMessageId]: "Please upload your Albert What-If report as a PDF.",
                }));
                return;
            }
            setWhatifUploadBusy(prev => ({ ...prev, [cardMessageId]: true }));
            setWhatifUploadError(prev => {
                const next = { ...prev };
                delete next[cardMessageId];
                return next;
            });
            try {
                const formData = new FormData();
                formData.append("dpr", file);
                const res = await fetch("/api/whatif-audit", { method: "POST", body: formData });
                let data: WhatIfAuditResponse & { message?: string };
                try {
                    data = (await res.json()) as WhatIfAuditResponse & { message?: string };
                } catch {
                    data = {} as WhatIfAuditResponse & { message?: string };
                }
                if (!res.ok || !data.exploration) {
                    setWhatifUploadError(prev => ({
                        ...prev,
                        [cardMessageId]: data?.message ?? "Upload failed. Please try again.",
                    }));
                    return;
                }

                // Build the read-only what-if scenario + register it.
                const scenarioId = "whatif-audit-" + Date.now().toString() + Math.random().toString(36).slice(2, 6);
                const scenario = buildWhatIfScenarioFromAudit(data, scenarioId, Date.now());
                planStore.addScenario(scenario);

                // 🔍 schedule card so the student can Open/Compare it.
                const cardMsgId = Date.now().toString() + Math.random().toString(36).slice(2, 6);
                const narrationId = Date.now().toString() + Math.random().toString(36).slice(2, 6) + "-n";
                setMessages(prev => [
                    ...prev,
                    buildScheduleCardMessage(scenario, cardMsgId, new Date()) as Message,
                    {
                        id: narrationId,
                        role: "assistant",
                        // `data.label` already ends with "— not your committed
                        // plan." and `data.cta` already carries the upload-a-DPR
                        // instruction, so let each be the sole voice for its
                        // point — no redundant/duplicated CTA (review scope-ux-1).
                        content:
                            `${data.exploration.summary}\n\n` +
                            `_${data.label}_ This is a **read-only hypothetical**. ${data.cta}`,
                        timestamp: new Date(),
                    },
                ]);
                setTimeout(scrollToBottom, 50);
            } catch {
                // Network / unexpected failure — surface a friendly error,
                // never crash. Do NOT log the file or its contents.
                setWhatifUploadError(prev => ({
                    ...prev,
                    [cardMessageId]: "I had trouble processing that file. Please try again.",
                }));
            } finally {
                setWhatifUploadBusy(prev => {
                    const next = { ...prev };
                    delete next[cardMessageId];
                    return next;
                });
            }
        },
        [planStore],
    );

    /** Keep-as-is — discard the bubble without applying. */
    const handleBubbleKeepAsIs = useCallback((messageId: string): void => {
        abortBubbleEnrichers(messageId);
        // E3.1 — Cancel/Keep-as-is drops the PENDING canvas overlay
        // WITHOUT committing: the sidebar reverts to the (untouched)
        // committed plan.
        planStore.clearPendingPreview();
        // E3.4 — Keep-as-is on a feasible:false bubble must ALSO clear
        // the E3.3 red card that renders alongside it, so dismissing the
        // bubble doesn't leave the red card hanging.
        planStore.clearInvalidProposal();
        patchMessage(messageId, {
            bubbleResolved: true,
            content: "Kept the plan as-is.",
        });
    }, [patchMessage, abortBubbleEnrichers]);

    /** Override-anyway — apply with `force: true` (Decision #32). */
    const handleBubbleOverrideAnyway = useCallback(async (messageId: string, pendingMutationId: string): Promise<void> => {
        patchMessage(messageId, { bubbleResolved: true });
        abortBubbleEnrichers(messageId);
        try {
            const result = await planConfirm({ pendingMutationId, force: true });
            if (!result.ok) {
                patchMessage(messageId, {
                    bubbleResolved: false,
                    content: `Override failed (${result.status}): ${result.error}`,
                });
                return;
            }
            if (result.data.forwardSchedule) {
                planStore.setForwardSchedule(result.data.forwardSchedule);
            }
            // E3.1 — the bubble is resolved; drop any PENDING overlay so
            // the sidebar shows the now-committed (student-preferred)
            // plan rather than a stale preview.
            planStore.clearPendingPreview();
            patchMessage(messageId, {
                bubbleResolved: true,
                content: "⚠ Override applied — plan saved as student-preferred-invalid-draft.",
            });
        } catch (err) {
            patchMessage(messageId, {
                bubbleResolved: false,
                content: `Override failed: ${err instanceof Error ? err.message : String(err)}`,
            });
        }
    }, [patchMessage, abortBubbleEnrichers]);

    // ----------------------------------------------------------------
    // Phase 4 Task E3.2 — canvas REVIEW-CARD actions. The review card
    // (rendered alongside the E3.1 preview overlay in the sidebar)
    // wires its three buttons to these handlers. They share the SAME
    // commit path as the chat-bubble Confirm (`planConfirm` →
    // `setForwardSchedule` → `clearPendingPreview`) via the pure
    // `applyReviewConfirm` / `applyReviewCancel` helpers, so the two
    // surfaces can never double-commit (each is one confirm + one
    // clear). The decision logic lives in `apps/web/lib/reviewCard.ts`.
    // ----------------------------------------------------------------

    /** Review-card Confirm — apply the staged mutation via the shared
     *  confirm path. Commits + clears the preview on success; leaves
     *  the preview staged on failure so the user can retry. */
    const handleReviewConfirm = useCallback(async (pendingMutationId: string): Promise<void> => {
        const res = await applyReviewConfirm(planStore, planConfirm, pendingMutationId);
        if (!res.ok) {
            // Surface a brief assistant note so the failure is visible;
            // the preview stays staged (handled inside applyReviewConfirm).
            const msg: Message = {
                id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
                role: "assistant",
                content: "Couldn't apply that change — it may have expired or conflicted. Try again from the canvas.",
                timestamp: new Date(),
            };
            setMessages(prev => [...prev, msg]);
            setTimeout(scrollToBottom, 50);
        }
    }, []);

    /** Review-card Cancel — drop the staged proposal + clear the
     *  preview WITHOUT a confirm round-trip. */
    const handleReviewCancel = useCallback((): void => {
        applyReviewCancel(planStore);
    }, []);

    /** E3.3 — Dismiss the RED invalid-proposal card. Nothing was ever
     *  staged or committed, so this just clears the slot; the committed
     *  plan is untouched. */
    const handleDismissInvalid = useCallback((): void => {
        planStore.clearInvalidProposal();
    }, []);

    /** Review-card Ask-why — route a scoped "why" question into the
     *  grounded chat agent (basic now; E4 builds the full ⋯ Explain).
     *  Mirrors the existing `handleProposeSlotChange` injection pattern:
     *  add a user-visible message, then drop into the v2 tool-use loop. */
    const handleReviewAskWhy = useCallback(async (_pendingMutationId: string, verb?: string): Promise<void> => {
        if (isLoading) return;
        // E4.1 — reuse the shared question-builder so all three Explain
        // affordances (slot ⋯, term header, review-card Ask-why) share
        // one surface and run through the same agent loop.
        const text = buildExplainProposalQuestion(verb);
        addMessage("user", text);
        setIsLoading(true);
        try {
            await handleSendV2(text);
        } catch (err) {
            addMessage("assistant", err instanceof Error ? err.message : "Could not explain the change.");
        } finally {
            setIsLoading(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isLoading]);

    // ----------------------------------------------------------------
    // H2.1 (plan 36) — CENTER-zone ScheduleWorkspace callbacks.
    // The workspace surfaces proposed scenarios with Confirm / Ask-why
    // buttons keyed by a `Scenario`. We map each back onto the EXISTING
    // confirm round-trip / Ask-why chat injection so the workspace and
    // the (still-mounted) review card share ONE commit path — neither
    // can double-commit, and R1 holds (planConfirm persists only the
    // forward_schedule; `parsed_dpr` is never written).
    // ----------------------------------------------------------------

    /** Workspace Confirm — a proposed scenario carries the same
     *  `pendingMutationId` the review card uses. Reuse `applyReviewConfirm`
     *  (the shared `planConfirm` → `setForwardSchedule` → `clearPendingPreview`
     *  path); on success ALSO promote the scenario in the model
     *  (`confirmProposed`) so a scenario created via the NEW addScenario
     *  API — not the compat preview path — is committed + dropped. */
    const handleWorkspaceConfirm = useCallback(async (scenario: Scenario): Promise<void> => {
        const pendingMutationId = scenario.pendingMutationId;
        if (!pendingMutationId) {
            // A proposed scenario with no mutation id cannot be confirmed
            // server-side; nothing to commit. (Defensive — proposed
            // scenarios always carry one in the live flow.)
            return;
        }
        const res = await applyReviewConfirm(planStore, planConfirm, pendingMutationId);
        if (!res.ok) {
            // Retry-able failure: the preview/scenario stays staged
            // (handled inside applyReviewConfirm). Surface a brief note.
            const msg: Message = {
                id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
                role: "assistant",
                content: "Couldn't apply that change — it may have expired or conflicted. Try again from the canvas.",
                timestamp: new Date(),
            };
            setMessages(prev => [...prev, msg]);
            setTimeout(scrollToBottom, 50);
            return;
        }
        // Commit succeeded. `applyReviewConfirm` already committed the new
        // forward_schedule (which, via the compat facade, supersedes ALL
        // scenarios + resets active to "committed"). Promoting the scenario
        // explicitly is a no-op in that case, but covers the path where the
        // confirm route returned no `forwardSchedule` so scenarios survived.
        planStore.confirmProposed(scenario.id);
    }, []);

    /** Workspace Ask-why — route into the grounded chat agent via the
     *  SAME shared question-builder the review card uses. Derive a verb
     *  hint from the proposed scenario label (the compat facade labels a
     *  staged preview `Proposed: <verb>`); falls back to a generic
     *  proposal question when no verb is present. */
    const handleWorkspaceAskWhy = useCallback((scenario: Scenario): void => {
        const verb = scenario.label.startsWith("Proposed: ")
            ? scenario.label.slice("Proposed: ".length)
            : undefined;
        void handleReviewAskWhy(scenario.pendingMutationId ?? "", verb);
    }, [handleReviewAskWhy]);

    /**
     * Phase 16 Task B — Update-DPR sidebar affordance.
     * POSTs the new PDF to /api/onboard/refresh-dpr; the route
     * fingerprint-compares with the stored DPR. On match → toast
     * "No changes detected"; on mismatch → schedule cleared +
     * replanned and the new schedule is applied directly to
     * `forwardSchedule` state. Surfaces parse / network errors as a
     * chat-visible assistant message so the student knows what failed.
     */
    const handleRefreshDpr = useCallback(async (file: File): Promise<void> => {
        if (!file.name.toLowerCase().endsWith(".pdf")) {
            window.alert("DPR file must be a PDF.");
            return;
        }
        // H5.1 — drive the ProfileRail's busy state for the duration of the
        // round-trip (the rail relabels "↻ Update DPR" → "Updating…").
        setRefreshingDpr(true);
        const formData = new FormData();
        formData.append("dpr", file);
        try {
            const res = await fetch("/api/onboard/refresh-dpr", {
                method: "POST",
                body: formData,
                credentials: "same-origin",
            });
            const data = await res.json() as {
                changed?: boolean;
                schedule?: ForwardSchedule;
                state?: string;
                error?: string;
            };
            if (!res.ok) {
                window.alert(`Update DPR failed: ${data.error ?? `HTTP ${res.status}`}`);
                return;
            }
            if (data.changed === false) {
                window.alert("No changes detected — your stored DPR matches this upload.");
                return;
            }
            if (data.schedule) {
                planStore.setForwardSchedule(data.schedule);
            }
            window.alert("Schedule updated to reflect your new DPR.");
        } catch (err) {
            window.alert(`Update DPR failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setRefreshingDpr(false);
        }
    }, []);

    /**
     * Phase 16 Task B — Clear-data sidebar affordance.
     * Test-only — gated server-side on NEXT_PUBLIC_ENABLE_TEST_CLEAR=1.
     * Confirms via dialog before firing; on success reloads the page so
     * the onboarding flow reruns from a clean slate.
     */
    const handleClearAll = useCallback(async (): Promise<void> => {
        const ok = window.confirm("Wipe ALL data for this student? This cannot be undone.");
        if (!ok) return;
        try {
            const res = await fetch("/api/session/clear", {
                method: "DELETE",
                credentials: "same-origin",
            });
            if (!res.ok) {
                const j = await res.json().catch(() => ({}));
                window.alert(`Clear failed: ${(j as { error?: string }).error ?? `HTTP ${res.status}`}`);
                return;
            }
            // Hard reload — re-runs the onboarding flow from a blank
            // /api/session/restore.
            window.location.reload();
        } catch (err) {
            window.alert(`Clear failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }, []);

    /**
     * Phase 4 Task E6.4 — STANDING self-serve account deletion.
     * Always available to a signed-in student (NOT gated on the
     * test-clear env flag). Wired to the always-on, authenticated
     * DELETE /api/session/delete route, which wipes ALL of the
     * student's data keyed on their session `auth.sub`. On success we
     * hard-reload back to the onboarding flow; on failure we surface
     * the error (mirrors handleClearAll). `deletingAccount` guards
     * against a double-submit while the request is in flight.
     */
    const handleDeleteAccount = useCallback(async (): Promise<void> => {
        const ok = window.confirm(
            "Permanently delete your account and ALL your data (plan, preferences, chat history)? This cannot be undone.",
        );
        if (!ok) return;
        setDeletingAccount(true);
        try {
            const res = await fetch("/api/session/delete", {
                method: "DELETE",
                credentials: "same-origin",
            });
            if (!res.ok) {
                const j = await res.json().catch(() => ({}));
                window.alert(
                    `Delete failed: ${(j as { error?: string }).error ?? `HTTP ${res.status}`}`,
                );
                setDeletingAccount(false);
                return;
            }
            // Hard reload — re-runs the onboarding flow from a blank
            // /api/session/restore.
            window.location.reload();
        } catch (err) {
            window.alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
            setDeletingAccount(false);
        }
    }, []);

    const handleFileUpload = useCallback(async (file: File) => {
        if (!file.name.toLowerCase().endsWith(".pdf")) {
            addMessage("assistant", "Please upload a PDF file (your Degree Progress Report).");
            return;
        }

        addMessage("user", `📎 Uploaded: ${file.name}`);
        setIsLoading(true);

        // DPR-only: the file is always uploaded under the "dpr" form
        // field. If the deterministic DPR parser fails, the route
        // returns an error message and we surface it so the student can
        // re-export and re-upload their DPR.
        try {
            const formData = new FormData();
            formData.append("dpr", file);

            const res = await fetch("/api/onboard", {
                method: "POST",
                body: formData,
            });
            const data = await res.json();

            addMessage("assistant", data.message);
            if (data.onboardingStep) setOnboardingStep(data.onboardingStep);
            if (data.parsedData) setParsedData(data.parsedData);
        } catch {
            addMessage("assistant", "I had trouble processing that file. Please try uploading again.");
        } finally {
            setIsLoading(false);
        }
    }, []);

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file) handleFileUpload(file);
    };

    // ============================================================
    // Phase 16 Task C — derive sidebar inputs (raw DPR + built profile).
    // ============================================================
    // Both restore (`{ kind: "dpr", report }`) and the live onboarding
    // route emit `parsedData` in the discriminated DPR shape. The build
    // runs at most once per parsedData / visaStatus change.
    const sidebarDpr = useMemo<DegreeProgressReport | null>(() => {
        if (!parsedData || parsedData.kind !== "dpr") return null;
        return (parsedData.report ?? null) as DegreeProgressReport | null;
    }, [parsedData]);
    const sidebarStudent = useMemo<StudentProfile | null>(() => {
        if (!sidebarDpr) return null;
        try {
            return buildStudentProfileFromDpr(sidebarDpr, {
                visaStatus: visaStatus === "f1" ? "f1" : "domestic",
            });
        } catch (err) {
            console.error("[chat page] buildStudentProfileFromDpr failed:", err);
            return null;
        }
    }, [sidebarDpr, visaStatus]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <div
            className={`${styles.chatPage} ${isDragOver ? styles.dragOver : ""}`}
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
        >
            {/* Header */}
            <header className={styles.header}>
                <a href="/" className={styles.headerLogo}>🎓 NYU Path</a>
                <span className={styles.headerBadge}>AI Advisor</span>
                {/* Schedule toggle is ALWAYS visible (May 2026 post-mortem
                    fix). Even before a forward plan exists, the sidebar
                    surfaces the empty state ("Ask me what to take next
                    semester to compute one"), the Update DPR / Clear
                    affordances, and — once a DPR is loaded — the
                    historical + IP term cards. The Phase 13 gate that
                    hid the button until `forwardSchedule !== null` left
                    students with no obvious way to inspect what data
                    the agent already had. */}
                <button
                    type="button"
                    className={styles.scheduleToggle}
                    onClick={() => setSidebarOpen(o => !o)}
                    aria-label="Toggle schedule sidebar"
                    aria-expanded={sidebarOpen}
                >
                    📅 Schedule
                </button>
            </header>

            {/* Phase 7-E W10.3 — persistent disclaimer banner.
                Per the privacy notice (/privacy). Reminds the student that
                this is an unofficial tool and they should verify with
                an NYU adviser before acting on any output. Stays
                visible at all times in the chat view. */}
            <div className={styles.disclaimerBanner} role="note">
                <span className={styles.disclaimerIcon} aria-hidden="true">⚠</span>
                <span>
                    AI advising assistant. <strong>Not a substitute for an academic adviser.</strong>{" "}
                    Verify all decisions with NYU advising before acting.
                </span>
                <button
                    type="button"
                    onClick={async () => {
                        await fetch("/api/auth/logout", { method: "POST" });
                        window.location.href = "/login";
                    }}
                    className={styles.logoutButton}
                    aria-label="Sign out"
                >
                    Sign out
                </button>
            </div>

            {/* Drag overlay */}
            {isDragOver && (
                <div className={styles.dropOverlay}>
                    <div className={styles.dropBox}>
                        <span className={styles.dropIcon}>📄</span>
                        <p>Drop your DPR PDF here</p>
                    </div>
                </div>
            )}

            {/* H2.1 (plan 36) — 3-zone shell:
                chat (LEFT) | ScheduleWorkspace (CENTER) | sidebar (RIGHT).
                The chat thread + composer become the LEFT zone; the new
                ScheduleWorkspace is mounted in the CENTER fed the SAME
                `planStore`; the existing ScheduleSidebar is passed UNCHANGED
                as the RIGHT zone (it stays a `position: fixed` overlay drawer
                toggled by the 📅 header button — H5 repurposes it into an
                in-flow profile-only rail). */}
            <ThreeZoneShell
                planStore={planStore}
                onConfirmProposed={handleWorkspaceConfirm}
                onAskWhy={handleWorkspaceAskWhy}
                left={
                    <>
            {/* Messages */}
            <div className={styles.messages}>
                {messages.map((msg, i) => {
                    // F1 — wizard cutover. In the `awaiting_dpr` state the
                    // structured OnboardingWizard (below) is the LIVE
                    // onboarding surface, so the legacy welcome bubble (its
                    // ask-and-reply "upload your DPR" prompt) is suppressed
                    // here to avoid double-prompting. Every OTHER onboarding
                    // state and the post-upload `complete` v2 path render
                    // their bubbles unchanged.
                    if (msg.id === "welcome" && onboardingStep === "awaiting_dpr") {
                        return null;
                    }
                    // Phase 17 Task D follow-up — plan_action_bubble has its
                    // own render block. Returns early so the regular
                    // assistant-bubble path below doesn't double-render the
                    // text + reasoning columns.
                    if (msg.kind === "plan_action_bubble" && msg.bubble) {
                        const buttons = bubbleHasButtons(msg.bubble.kind);
                        const showOverride = bubbleHasOverrideButton(msg.bubble.kind);
                        const stage2Entries = Array.from(msg.bubble.stage2.values());
                        // While the bubble is unresolved, the bubble text
                        // is the source of truth (the polish reducer writes
                        // to it). Once the user clicks Confirm / Keep-as-is /
                        // Override-anyway, `msg.content` carries the
                        // resolved-state caption ("✓ Applied." etc).
                        const displayedText = msg.bubbleResolved ? msg.content : msg.bubble.text;
                        return (
                            <div
                                key={msg.id}
                                className={`${styles.messageBubble} ${styles.assistant}`}
                                style={{ animationDelay: `${Math.min(i * 0.05, 0.3)}s` }}
                                data-kind="plan_action_bubble"
                                data-bubble-kind={msg.bubble.kind}
                            >
                                <div className={styles.avatar}>🎓</div>
                                <div className={styles.bubbleContent}>
                                    <div
                                        className={styles.bubbleText}
                                        data-bubble-text="true"
                                        dangerouslySetInnerHTML={{
                                            __html: renderMarkdown(displayedText),
                                        }}
                                    />
                                    {stage2Entries.length > 0 && (
                                        <ul
                                            data-bubble-stage2="true"
                                            style={{
                                                margin: "8px 0 0",
                                                padding: "0 0 0 16px",
                                                fontSize: "0.85em",
                                                color: "#444",
                                            }}
                                        >
                                            {stage2Entries.map((s, idx) => (
                                                <li key={idx}>{s.message}</li>
                                            ))}
                                        </ul>
                                    )}
                                    {buttons && !msg.bubbleResolved && (
                                        <div
                                            data-bubble-buttons="true"
                                            style={{
                                                display: "flex",
                                                gap: 8,
                                                marginTop: 10,
                                                flexWrap: "wrap",
                                            }}
                                        >
                                            <button
                                                type="button"
                                                onClick={() => void handleBubbleConfirm(msg.id, msg.bubble!.pendingMutationId)}
                                                style={{
                                                    padding: "6px 12px",
                                                    borderRadius: 6,
                                                    background: "#0d6efd",
                                                    color: "white",
                                                    border: "none",
                                                    cursor: "pointer",
                                                }}
                                            >
                                                Confirm
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => handleBubbleKeepAsIs(msg.id)}
                                                style={{
                                                    padding: "6px 12px",
                                                    borderRadius: 6,
                                                    background: "#e9ecef",
                                                    color: "#212529",
                                                    border: "none",
                                                    cursor: "pointer",
                                                }}
                                            >
                                                Keep as-is
                                            </button>
                                            {showOverride && (
                                                <button
                                                    type="button"
                                                    onClick={() => void handleBubbleOverrideAnyway(msg.id, msg.bubble!.pendingMutationId)}
                                                    style={{
                                                        padding: "6px 12px",
                                                        borderRadius: 6,
                                                        background: "#fff",
                                                        color: "#dc3545",
                                                        border: "1px solid #dc3545",
                                                        cursor: "pointer",
                                                    }}
                                                >
                                                    Override anyway
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    }

                    // H4.2b-3 — whatif_upload_card: render the Branch-A
                    // "explore precisely" upload offer. Uploading the
                    // student's Albert What-If audit produces a read-only
                    // 🔍 what-if scenario (never confirmable).
                    if (msg.kind === "whatif_upload_card" && msg.whatifUpload) {
                        return (
                            <div
                                key={msg.id}
                                className={`${styles.messageBubble} ${styles.assistant}`}
                                style={{ animationDelay: `${Math.min(i * 0.05, 0.3)}s` }}
                                data-kind="whatif_upload_card"
                            >
                                <div className={styles.avatar}>🎓</div>
                                <div className={styles.bubbleContent}>
                                    <WhatIfUploadCard
                                        hypotheticalProgram={msg.whatifUpload.hypotheticalProgram}
                                        onUpload={(file) => void handleWhatIfAuditUpload(file, msg.id)}
                                        uploading={whatifUploadBusy[msg.id]}
                                        error={whatifUploadError[msg.id]}
                                    />
                                </div>
                            </div>
                        );
                    }

                    // H4.2a — schedule_card: render a ScheduleCard artifact
                    // in the chat thread so the student can Open or Compare
                    // the new scenario from the conversation.
                    if (msg.kind === "schedule_card" && msg.scheduleCard) {
                        const sc = msg.scheduleCard;
                        return (
                            <div
                                key={msg.id}
                                className={`${styles.messageBubble} ${styles.assistant}`}
                                style={{ animationDelay: `${Math.min(i * 0.05, 0.3)}s` }}
                                data-kind="schedule_card"
                            >
                                <div className={styles.avatar}>🎓</div>
                                <div className={styles.bubbleContent}>
                                    <ScheduleCard
                                        scenarioId={sc.scenarioId}
                                        kind={sc.kind}
                                        label={sc.label}
                                        summary={sc.summary}
                                        verdict={sc.verdict}
                                        onOpen={(id) => planStore.setActive(id)}
                                        onCompare={(id) => {
                                            // Guard: committed must be non-null and
                                            // the scenario must not equal "committed"
                                            // (openCompare throws on equal ids).
                                            const state = planStore.getScenarioState();
                                            if (state.committed === null) return;
                                            if (id === "committed") return;
                                            try {
                                                planStore.openCompare("committed", id);
                                            } catch {
                                                // Safety: if openCompare rejects (e.g.
                                                // scenario was already discarded), do
                                                // nothing — the workspace handles it.
                                            }
                                        }}
                                    />
                                </div>
                            </div>
                        );
                    }

                    return (
                    <div
                        key={msg.id}
                        className={`${styles.messageBubble} ${styles[msg.role]}`}
                        style={{ animationDelay: `${Math.min(i * 0.05, 0.3)}s` }}
                    >
                        {msg.role === "assistant" && (
                            <div className={styles.avatar}>🎓</div>
                        )}
                        <div className={styles.bubbleContent}>
                            {/* Reasoning block — header + indented thinking text.
                                Live: shimmering "Thinking" with streaming sentences.
                                Done: "Reasoned for Xs" / "Failed after Xs", click to toggle. */}
                            {msg.role === "assistant" && msg.startedAt && (() => {
                                const settled = msg.completedAt || msg.failedAt;
                                const inFlight = !settled;
                                const headerText = msg.failedAt
                                    ? `Failed after ${formatDuration(msg.failedAt - msg.startedAt)}`
                                    : settled
                                    ? `Reasoned for ${formatDuration((msg.completedAt ?? Date.now()) - msg.startedAt)}`
                                    : "Thinking";
                                const expanded = inFlight ? true : !!msg.traceExpanded;
                                const visibleThought = (msg.thinkingText ?? "").slice(0, msg.thinkingRevealed ?? 0);
                                const hasAnyThought = (msg.thinkingText ?? "").length > 0;
                                return (
                                    <div className={styles.reasoning}>
                                        {settled ? (
                                            <button
                                                type="button"
                                                className={styles.reasoningHeader}
                                                onClick={() => updateMessage(msg.id, { traceExpanded: !msg.traceExpanded })}
                                                aria-expanded={!!msg.traceExpanded}
                                                aria-controls={`reasoning-${msg.id}`}
                                                disabled={!hasAnyThought}
                                            >
                                                <span className={styles.reasoningHeaderText}>{headerText}</span>
                                                {hasAnyThought && (
                                                    <span className={styles.reasoningChevron} aria-hidden="true">
                                                        {msg.traceExpanded ? "▾" : "▸"}
                                                    </span>
                                                )}
                                            </button>
                                        ) : (
                                            <div
                                                className={`${styles.reasoningHeader} ${styles.reasoningHeaderActive}`}
                                                role="status"
                                                aria-live="polite"
                                            >
                                                <span className={styles.reasoningHeaderText}>{headerText}</span>
                                            </div>
                                        )}
                                        {expanded && hasAnyThought && (
                                            <div
                                                id={`reasoning-${msg.id}`}
                                                className={styles.reasoningBody}
                                            >
                                                {visibleThought.split("\n\n").map((para, idx) => (
                                                    <p key={idx} className={styles.reasoningParagraph}>
                                                        {para}
                                                        {inFlight && idx === visibleThought.split("\n\n").length - 1 && (
                                                            <span className={styles.reasoningCaret} aria-hidden="true" />
                                                        )}
                                                    </p>
                                                ))}
                                                {msg.toolStatuses && msg.toolStatuses.length > 0 && (
                                                    <ul className={styles.reasoningToolList}>
                                                        {msg.toolStatuses.map((t, idx) => (
                                                            <li key={idx} className={styles.reasoningToolItem}>
                                                                <span className={styles.reasoningToolIcon}>
                                                                    {t.state === "running" ? "•" : t.state === "error" ? "⚠" : "✓"}
                                                                </span>
                                                                <span className={styles.reasoningToolText}>
                                                                    {getPastVerb(t.toolName)}
                                                                    {t.error ? ` — ${t.error}` : ""}
                                                                </span>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })()}
                            {/* Final-answer bubble. Hidden while empty so we don't render
                                an empty white card while the agent is still thinking. */}
                            {(() => {
                                const isV2 = msg.role === "assistant" && !!msg.startedAt;
                                const text = isV2
                                    ? (msg.content ?? "").slice(0, msg.contentRevealed ?? 0)
                                    : (msg.content ?? "");
                                if (!text) return null;
                                const inFlight = isV2 && !msg.completedAt && !msg.failedAt;
                                return (
                                    <div
                                        className={styles.bubbleText}
                                        dangerouslySetInnerHTML={{
                                            __html: renderMarkdown(text) + (inFlight ? "" : ""),
                                        }}
                                    />
                                );
                            })()}
                            {/* Validator block warning (§9.1 Part 9) */}
                            {msg.validatorViolations && msg.validatorViolations.length > 0 && (
                                <div style={{ fontSize: "0.85em", marginTop: 8, padding: 8, background: "#fff3cd", borderRadius: 6, color: "#664d03" }}>
                                    ⚠ <strong>Could not fully ground this reply.</strong>
                                    <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                                        {msg.validatorViolations.map((v, idx) => (
                                            <li key={idx}>
                                                <code>{v.kind}</code>
                                                {v.caveatId ? ` (${v.caveatId})` : ""}: {v.detail}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {/* Two-step profile-update confirm button (§7.2) */}
                            {msg.pendingMutationId && (
                                <button
                                    onClick={() => handleConfirmPending(msg.pendingMutationId!)}
                                    disabled={isLoading}
                                    style={{ marginTop: 8, padding: "6px 12px", borderRadius: 6, background: "#0d6efd", color: "white", border: "none", cursor: "pointer" }}
                                >
                                    Confirm profile update
                                </button>
                            )}
                        </div>
                    </div>
                    );
                })}

                {/* F1 — wizard cutover (the LIVE onboarding). The
                    structured OnboardingWizard REPLACES the legacy
                    welcome/upload ask-and-reply flow for the `awaiting_dpr`
                    state. Its Upload step reuses `/api/onboard`; once
                    `onReachPlan` fires (`handleWizardReachPlan`) the existing
                    rail hands off to `onboardingStep="complete"` + the v2 SSE
                    path automatically. `onPreviewIntendedMajor`
                    (`handleIntendedMajorPreview`, E5.5) wires the undeclared
                    student's hedged intended-major RAG-preview arm. No
                    "use chat instead" fallback this pass — the wizard's
                    skip-all no-dead-end guarantees a plan is always
                    reachable. All OTHER onboarding states + the `complete`
                    v2 path are unchanged. */}
                {onboardingStep === "awaiting_dpr" && (
                    <OnboardingWizard
                        onReachPlan={handleWizardReachPlan}
                        onPreviewIntendedMajor={handleIntendedMajorPreview}
                    />
                )}

                {/* Legacy v1 loader — only shown for onboarding turns
                    that go through the JSON `/api/chat` route (which
                    has no SSE indicator of its own). v2 turns get
                    their reasoning header + streaming block instead. */}
                {isLoading && !(onboardingStep === "complete" && parsedData) && (
                    <div className={`${styles.messageBubble} ${styles.assistant}`}>
                        <div className={styles.avatar}>🎓</div>
                        <div className={styles.bubbleContent}>
                            <div className={styles.typing}>
                                <span></span><span></span><span></span>
                            </div>
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input area */}
            <div className={styles.inputArea}>
                <div className={styles.inputContainer}>
                    {/* F1 — the legacy `📎` upload button is removed: in the
                        `awaiting_dpr` state the OnboardingWizard (above) owns
                        the Upload step (same `/api/onboard` parse), so the
                        inline upload affordance is no longer the live path.
                        The page-level drag-drop handler still accepts a DPR. */}
                    <textarea
                        ref={inputRef}
                        className={styles.textInput}
                        placeholder={
                            onboardingStep === "awaiting_dpr"
                                ? "Upload your DPR (or type a message)…"
                                : "Type your message..."
                        }
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        rows={1}
                        disabled={isLoading}
                    />
                    <button
                        className={styles.sendBtn}
                        onClick={handleSend}
                        disabled={!input.trim() || isLoading}
                    >
                        ↑
                    </button>
                </div>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf"
                    className={styles.hiddenFileInput}
                    onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleFileUpload(file);
                        e.target.value = "";
                    }}
                />
            </div>
                    </>
                }
                right={
                    /* H5.1 (plan 36) — the RIGHT zone is the profile-only
                       ProfileRail: SummaryCard DPR-derived read-only fields +
                       the ↻ Update DPR control + the scenarios list (reading
                       the SAME `planStore`) + the privacy note + account
                       actions. The schedule grid + slot popovers + the
                       review/preview card moved to the CENTER-zone
                       ScheduleWorkspace; what-if creation is chat-only (no
                       spawn control here). onSelectScenario/onCompareScenario
                       reuse the chat ScheduleCard pattern: setActive + a
                       committed-vs-row openCompare guarded against
                       null-committed / equal ids (openCompare throws). */
                    <ProfileRail
                        student={sidebarStudent}
                        dpr={sidebarDpr}
                        planStore={planStore}
                        onRefreshDpr={handleRefreshDpr}
                        refreshing={refreshingDpr}
                        onClearAll={handleClearAll}
                        onDeleteAccount={handleDeleteAccount}
                        deletingAccount={deletingAccount}
                        onSelectScenario={(id) => planStore.setActive(id)}
                        onCompareScenario={(id) => {
                            // Guard: committed must be non-null and the
                            // scenario id must not be "committed" (openCompare
                            // throws on equal/unresolvable ids).
                            const state = planStore.getScenarioState();
                            if (state.committed === null) return;
                            if (id === "committed") return;
                            try {
                                planStore.openCompare("committed", id);
                            } catch {
                                /* swallow — defensive; the guards above already
                                   cover the throwing cases. */
                            }
                        }}
                    />
                }
            />
        </div>
    );
}
