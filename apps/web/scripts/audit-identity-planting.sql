-- ============================================================
-- audit-identity-planting.sql — READ-ONLY forensic audit
-- ============================================================
-- Until PR #58 the chat v2 route took `userId = cookie.sub ?? body.userId`,
-- so a cookie-less caller could write rows under ANY id (bootstrap profile +
-- parsed_dpr, homeschool-/visa- audit rows, chat_messages, session_summaries,
-- forward_schedules, schedule_preferences, pending_mutations). The first real
-- OTP login (lib/auth/otp.ts verifyOtp upsert) then ADOPTS that row.
--
-- This query lists suspect students as COUNTS + IDS ONLY. It selects no email,
-- no DPR, no profile, no message/summary text. Runbook:
--   Docs/audits/2026-10-06-chat-v2-identity-planting-runbook.md
--
-- Run (owner only — preferably against a Neon BRANCH of production):
--   psql "$AUDIT_DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/scripts/audit-identity-planting.sql
-- The whole thing runs inside a READ ONLY transaction and ends in ROLLBACK,
-- so Postgres itself rejects any write.
--
-- "First login" = the earliest CONSUMED (verified) OTP for the id — NOT the
-- earliest issued one: anyone can make an OTP get ISSUED for any NetID (POST
-- /api/auth/otp), so issued_at would not prove the owner had logged in.
-- Login ids are the lower-cased email local part (otp.ts emailToStudentId).
-- ============================================================

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';

WITH params AS (
    -- Clock-skew tolerance: consumed_at / audit confirmed_at / chat created_at
    -- come from the app-server clock, students.created_at from the DB clock.
    SELECT interval '5 seconds' AS skew
),
otp AS (
    SELECT lower(split_part(email, '@', 1))                 AS sid,
           min(consumed_at)                                  AS first_login_at,
           min(issued_at)                                    AS first_issued_at
    FROM email_otps
    GROUP BY 1
),
aud AS (
    -- ANY audit row counts, not only the route's bootstrap-/homeschool-/visa-
    -- ids: confirm_profile_update (a tool, so it also ran under the forged id)
    -- writes its own ids AND re-persists parsed_dpr. Every other audit writer
    -- (refresh-dpr) is cookie-authenticated, so nothing legitimate predates
    -- the first login.
    SELECT student_id,
           min(confirmed_at)                                 AS first_audit,
           max(confirmed_at) FILTER (
               WHERE pending_mutation_id LIKE 'dpr_refresh_%') AS last_dpr_refresh
    FROM audit_log
    GROUP BY 1
),
chat AS (SELECT student_id, min(created_at)  AS first_at FROM chat_messages     GROUP BY 1),
summ AS (SELECT student_id, min(created_at)  AS first_at FROM session_summaries GROUP BY 1),
-- n_fps: refresh-dpr hard-deletes a student's schedules, and every legitimate
-- writer fingerprints the student's STORED DPR (chat turns re-send the restored
-- DPR; plan routes + what-if confirm read it from the DB). So >1 distinct
-- fingerprint means a second DPR was planned under this id — the one signal
-- that can catch a body-id write made AFTER the owner's login.
fs   AS (SELECT student_id, min(computed_at) AS first_at,
                count(DISTINCT dpr_fingerprint) AS n_fps
         FROM forward_schedules GROUP BY 1),
pm   AS (SELECT student_id, min(created_at)  AS first_at FROM pending_mutations GROUP BY 1),
facts AS (
    SELECT s.student_id,
           s.email IS NOT NULL                   AS claimed,
           s.profile IS NOT NULL                 AS has_profile,
           s.parsed_dpr IS NOT NULL              AS has_dpr,
           s.created_at,
           o.first_login_at,
           a.first_audit,
           a.last_dpr_refresh,
           c.first_at  AS chat_first,
           su.first_at AS summ_first,
           f.first_at  AS fs_first,
           f.n_fps,
           sp.updated_at AS prefs_at,
           p.first_at  AS pm_first,
           (o.first_login_at - (SELECT skew FROM params)) AS cutoff
    FROM students s
    -- exact match: only an id equal to a lower-cased local part can be adopted
    LEFT JOIN otp  o  ON o.sid = s.student_id
    LEFT JOIN aud  a  ON a.student_id  = s.student_id
    LEFT JOIN chat c  ON c.student_id  = s.student_id
    LEFT JOIN summ su ON su.student_id = s.student_id
    LEFT JOIN fs   f  ON f.student_id  = s.student_id
    LEFT JOIN schedule_preferences sp ON sp.student_id = s.student_id
    LEFT JOIN pm   p  ON p.student_id  = s.student_id
),
signals AS (
    SELECT *,
           coalesce(created_at        < cutoff, false) AS sig_created,
           coalesce(first_audit       < cutoff, false) AS sig_audit,
           coalesce(chat_first        < cutoff, false) AS sig_chat,
           coalesce(summ_first        < cutoff, false) AS sig_summary,
           coalesce(fs_first          < cutoff, false) AS sig_schedule,
           coalesce(prefs_at          < cutoff, false) AS sig_prefs,
           coalesce(pm_first          < cutoff, false) AS sig_pending,
           coalesce(n_fps > 1, false)                  AS sig_multi_dpr
    FROM facts
),
classified AS (
    SELECT *,
           CASE
             WHEN student_id = 'anonymous'                              THEN 'anonymous_literal'
             WHEN NOT claimed AND (student_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                   OR student_id LIKE 'cohortA-%')      THEN 'browser_uuid'
             WHEN NOT claimed AND student_id <> lower(student_id)       THEN 'unadoptable_case_variant'
             WHEN NOT claimed AND first_login_at IS NULL                THEN '1_UNCLAIMED_NETID'
             WHEN claimed AND first_login_at IS NULL                    THEN 'anomaly_claimed_without_otp'
             WHEN pre_login_sig AND NOT claimed                         THEN 'anomaly_unclaimed_prelogin'
             WHEN pre_login_sig                                         THEN '2_ADOPTED_SUSPECT'
             WHEN sig_multi_dpr                                         THEN '3_MULTI_DPR_SUSPECT'
             WHEN NOT claimed                                           THEN 'recreated_after_login'
             ELSE 'clean'
           END AS class
    FROM (
        SELECT *,
               (sig_created OR sig_audit OR sig_chat OR sig_summary
                 OR sig_schedule OR sig_prefs OR sig_pending) AS pre_login_sig
        FROM signals
    ) sg
)
SELECT class,
       count(*)                                   AS n,
       count(*) FILTER (WHERE has_dpr)            AS n_with_parsed_dpr,
       count(*) FILTER (WHERE has_profile)        AS n_with_profile,
       count(*) FILTER (WHERE last_dpr_refresh > first_login_at) AS n_dpr_refreshed_since_login,
       -- id[signals] — pre-login codes (earliest row predates first login):
       -- C=row created, A=any audit row, M=chat, S=summary, F=forward schedule,
       -- P=prefs, Q=pending mutation. X = >1 distinct DPR fingerprint among the
       -- schedules (any time). +dpr = parsed_dpr present; +refreshed = a
       -- cookie-auth DPR refresh happened after login.
       array_agg(
           student_id || '[' || concat_ws(',',
               CASE WHEN sig_created  THEN 'C' END,
               CASE WHEN sig_audit    THEN 'A' END,
               CASE WHEN sig_chat     THEN 'M' END,
               CASE WHEN sig_summary  THEN 'S' END,
               CASE WHEN sig_schedule THEN 'F' END,
               CASE WHEN sig_prefs    THEN 'P' END,
               CASE WHEN sig_pending  THEN 'Q' END,
               CASE WHEN sig_multi_dpr THEN 'X' END,
               CASE WHEN has_dpr      THEN '+dpr' END,
               CASE WHEN last_dpr_refresh > first_login_at THEN '+refreshed' END
           ) || ']'
           ORDER BY student_id
       ) FILTER (WHERE class <> 'clean')          AS ids
FROM classified
GROUP BY class
ORDER BY class;

ROLLBACK;
