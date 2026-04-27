// ============================================================
// Postgres schema (Phase 7-B Step 8) — Drizzle ORM definitions
// ============================================================
// Tables wired in this step:
//   - students          (current canonical profile per studentId)
//   - sessionSummaries  (rolling window of last 5 per student)
//   - auditLog          (immutable record of confirmed profile mutations)
//   - cohortAssignments (userId → cohort, replaces in-memory setCohortAssignment)
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
    pgEnum,
    primaryKey,
    index,
} from "drizzle-orm/pg-core";

export const cohortEnum = pgEnum("cohort", ["alpha", "beta", "invite", "public", "limited"]);

export const students = pgTable("students", {
    studentId: text("student_id").primaryKey(),
    email: text("email").unique(),
    parsedTranscript: jsonb("parsed_transcript"),
    declaredPrograms: jsonb("declared_programs").notNull().default("[]"),
    visaStatus: text("visa_status"),
    catalogYear: text("catalog_year"),
    homeSchool: text("home_school"),
    flags: jsonb("flags").notNull().default("[]"),
    /** Full StudentProfile snapshot persisted by confirm_profile_update. */
    profile: jsonb("profile"),
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

export const cohortAssignments = pgTable("cohort_assignments", {
    userId: text("user_id").primaryKey(),
    cohort: cohortEnum("cohort").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    assignedBy: text("assigned_by"),
});

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
