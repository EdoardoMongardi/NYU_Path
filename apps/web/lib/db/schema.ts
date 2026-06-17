// ============================================================
// Postgres schema (Phase 7-B Step 8) — Drizzle ORM definitions
// ============================================================
// Tables wired in this step:
//   - students          (current canonical profile per studentId)
//   - sessionSummaries  (rolling window of last 5 per student)
//   - auditLog          (immutable record of confirmed profile mutations)
//
// Running on Neon Postgres in production. Drizzle migrations live in
// apps/web/drizzle/. Schema is intentionally narrow — we only persist
// the bits the engine asked for in Phase 7-B Step 8 of the roadmap.
// ============================================================

import {
    pgTable,
    text,
    timestamp,
    jsonb,
    serial,
    primaryKey,
    index,
} from "drizzle-orm/pg-core";

export const students = pgTable("students", {
    studentId: text("student_id").primaryKey(),
    email: text("email").unique(),
    declaredPrograms: jsonb("declared_programs").notNull().default("[]"),
    visaStatus: text("visa_status"),
    catalogYear: text("catalog_year"),
    homeSchool: text("home_school"),
    flags: jsonb("flags").notNull().default("[]"),
    /** Full StudentProfile snapshot persisted by confirm_profile_update. */
    profile: jsonb("profile"),
    /**
     * Phase 16 Task A — most-recent parsed DegreeProgressReport for the
     * student. Written by `confirm_profile_update` (initial onboarding)
     * and `/api/onboard/refresh-dpr` (Update-DPR). Read by the Phase 16
     * login-restore route so a returning student doesn't re-upload.
     */
    parsedDpr: jsonb("parsed_dpr"),
    lastSessionDate: timestamp("last_session_date", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessionSummaries = pgTable("session_summaries", {
    id: serial("id").primaryKey(),
    studentId: text("student_id").notNull().references(() => students.studentId, { onDelete: "cascade" }),
    /** ISO date the session occurred (matches engine SessionSummary.date). */
    date: text("date").notNull(),
    /** ~600-token natural-language summary the agent wrote at end of turn. */
    summary: text("summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
    byStudent: index("session_summaries_student_idx").on(t.studentId, t.id),
}));

export const auditLog = pgTable("audit_log", {
    id: serial("id").primaryKey(),
    studentId: text("student_id").notNull().references(() => students.studentId, { onDelete: "cascade" }),
    pendingMutationId: text("pending_mutation_id").notNull(),
    /** Which StudentProfile field changed. Mirrors PendingProfileMutation['field']. */
    field: text("field").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
    byStudent: index("audit_log_student_idx").on(t.studentId, t.confirmedAt),
}));

/**
 * Email-OTP auth (Phase 7-B Step 11). One row per outstanding OTP;
 * rows expire 10 minutes after issuance and are deleted on consume.
 * The `consumedAt` column lets us reject double-redemption without
 * relying on best-effort row deletion.
 */
export const emailOtps = pgTable("email_otps", {
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, (t) => ({
    pk: primaryKey({ columns: [t.email, t.issuedAt] }),
    byEmail: index("email_otps_email_idx").on(t.email),
}));

/**
 * Phase 16 Task A — durable forward-schedule history. Soft-delete via
 * `superseded_at`; the latest non-superseded row is the live plan that
 * the login-restore route hydrates back into the session. Older rows
 * stay in the DB for analytics + cohort eval.
 */
export const forwardSchedules = pgTable("forward_schedules", {
    id: serial("id").primaryKey(),
    studentId: text("student_id").notNull().references(() => students.studentId, { onDelete: "cascade" }),
    schedule: jsonb("schedule").notNull(),
    state: text("state").notNull(),
    dprFingerprint: text("dpr_fingerprint").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
}, (t) => ({
    byStudentActive: index("forward_schedules_student_active_idx").on(t.studentId, t.computedAt),
}));

/**
 * Phase 16 Task A — single SchedulePreferences row per student
 * (upsert). Preferences are *intent*, not history; the latest write
 * replaces the prior version. Audit trail of pref changes goes to
 * the existing `audit_log` table separately.
 */
export const schedulePreferences = pgTable("schedule_preferences", {
    studentId: text("student_id").primaryKey().references(() => students.studentId, { onDelete: "cascade" }),
    preferences: jsonb("preferences").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Phase 16 Task A — append-only chat transcript. Each row is one
 * message (user / assistant / system) the student saw. JSONB columns
 * carry the structured side-effects (tool invocations, validator
 * violations) so the rendered transcript matches what the student saw
 * last session, including the click-to-confirm UI for any still-
 * pending profile mutations. The monotonically-increasing `id` orders
 * the timeline.
 */
export const chatMessages = pgTable("chat_messages", {
    id: serial("id").primaryKey(),
    studentId: text("student_id").notNull().references(() => students.studentId, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    thinkingText: text("thinking_text"),
    toolInvocations: jsonb("tool_invocations"),
    validatorViolations: jsonb("validator_violations"),
    pendingMutationId: text("pending_mutation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
    byStudent: index("chat_messages_student_idx").on(t.studentId, t.id),
}));

/**
 * Phase 4 Task E6.3 — durable propose→confirm staging. Replaces the
 * single-instance in-process `Map` so a staged plan-change proposal
 * survives a process restart / multi-instance deploy. One row per
 * `pendingMutationId`; the `mutations` JSONB is the exact PlanMutation[]
 * the confirm re-applies. `expires_at` carries the 10-min TTL so a
 * crashed mid-confirm flow ages out instead of leaking rows. Rows are
 * deleted on a successful `take` (single-use) and cascade-deleted when
 * the student row is removed (self-serve deletion / test-clear).
 */
export const pendingMutations = pgTable("pending_mutations", {
    pendingMutationId: text("pending_mutation_id").primaryKey(),
    studentId: text("student_id").notNull().references(() => students.studentId, { onDelete: "cascade" }),
    mutations: jsonb("mutations").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => ({
    byStudent: index("pending_mutations_student_idx").on(t.studentId),
    byExpiry: index("pending_mutations_expires_idx").on(t.expiresAt),
}));
