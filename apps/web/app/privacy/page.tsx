// ============================================================
// /privacy — user-facing privacy notice
// ============================================================
// Static server component. The login page links here. The
// developer-facing companion (data-handling reference, table names,
// file pointers) lives at Docs/reference/PRIVACY.md and should be
// kept in sync with this page when data handling changes.
//
// Accuracy note: this describes the PERSISTENT, signed-in deployment
// (Postgres + NYU-email OTP accounts). Anonymous use stores nothing
// server-side. Verified against the code on 2026-06-15.
// ============================================================

import type { Metadata } from "next";

export const metadata: Metadata = {
    title: "Privacy · NYU Path",
    description: "What NYU Path collects, stores, and how to delete it.",
};

const container: React.CSSProperties = {
    maxWidth: "720px",
    margin: "0 auto",
    padding: "2.5rem 1.25rem 4rem",
    lineHeight: 1.6,
};

export default function PrivacyPage() {
    return (
        <main style={container}>
            <h1>Privacy &amp; data handling</h1>
            <p>
                <em>Last updated 2026-06-15.</em> NYU Path is a course-planning assistant for NYU
                undergraduates. It handles your academic records, so we keep this notice specific
                and FERPA-aware. It describes what the system collects, what it stores, who it is
                shared with, and how to delete it.
            </p>

            <h2>Anonymous use stores nothing</h2>
            <p>
                If you use NYU Path without signing in, nothing about you is saved on our servers —
                your session lives in memory for that visit only and is gone when it ends. Saving
                across sessions happens <strong>only when you sign in</strong>.
            </p>

            <h2>Signing in</h2>
            <p>
                Sign-in uses your NYU email. We email you a single-use 6-digit code (delivered
                through <strong>Resend</strong>); the code is stored only as a hash, expires after
                10 minutes, and can be used once. A successful sign-in creates your account and
                sets a session cookie that keeps you signed in for 30 days. Signing in for the
                first time is the same as signing up.
            </p>

            <h2>What we store when you are signed in</h2>
            <p>Tied to your account, so you can pick up where you left off:</p>
            <ul>
                <li>Your NYU email address (for sign-in).</li>
                <li>
                    The <strong>parsed contents</strong> of the Degree Progress Report (DPR) you
                    upload — courses, requirements, GPA, credits. We extract the data and{" "}
                    <strong>do not keep the PDF file</strong> itself. The Albert DPR is the{" "}
                    <strong>only</strong> document NYU Path accepts — we do not take or process
                    unofficial transcripts anywhere in the system.
                </li>
                <li>Your profile: declared programs, home school, catalog year, visa status, and related flags.</li>
                <li>Your degree plan and its revision history.</li>
                <li>Your scheduling preferences.</li>
                <li>Your chat transcript with the assistant, plus short rolling summaries of past sessions.</li>
                <li>An audit log of profile changes you explicitly confirm.</li>
            </ul>

            <h2>AI processing &amp; third parties</h2>
            <p>
                To answer you, the assistant sends your message and the relevant academic context to
                large-language-model providers — <strong>Anthropic (Claude)</strong> as the primary
                model and <strong>OpenAI</strong> as a fallback. Sign-in emails are sent via{" "}
                <strong>Resend</strong>. We do not sell your data or use it for advertising.
            </p>

            <h2>Retention &amp; deletion</h2>
            <p>
                Because the point is to resume your planning across sessions, your account data is
                retained until it is deleted. Deleting your account removes all of the above in one
                step (it cascades across every per-student record). Where the operator has enabled
                the in-app &ldquo;clear my data&rdquo; control you can do this yourself from the chat
                screen; otherwise contact the operator / NYU to request deletion.
            </p>

            <h2>A reminder</h2>
            <p>
                NYU Path is an assistant, not an official source. Confirm anything that affects your
                graduation, registration, or financial aid with your academic adviser. This notice
                reflects how the system works as of the date above; if you have questions about a
                specific deployment, contact the operator.
            </p>
        </main>
    );
}
