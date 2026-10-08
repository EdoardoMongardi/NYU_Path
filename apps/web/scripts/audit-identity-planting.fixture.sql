-- ============================================================
-- audit-identity-planting.fixture.sql — SYNTHETIC self-test seed
-- ============================================================
-- !!! DISPOSABLE DATABASE ONLY — this file INSERTS rows. Never run it against
-- production or a Neon branch you care about. It exists so the read-only
-- audit query can be checked against known answers before it is trusted:
--
--   createdb identity_audit_selftest
--   for f in apps/web/drizzle/000*.sql; do psql -d identity_audit_selftest -v ON_ERROR_STOP=1 -f "$f"; done
--   psql -d identity_audit_selftest -v ON_ERROR_STOP=1 -f apps/web/scripts/audit-identity-planting.fixture.sql
--   psql -d identity_audit_selftest -v ON_ERROR_STOP=1 -f apps/web/scripts/audit-identity-planting.sql
--
-- All ids are fake. T = 2026-09-01 12:00 UTC is each student's real first
-- verified login unless noted. EXPECTED audit output (class → ids):
--
--   1_UNCLAIMED_NETID           fx_unclaimed[+dpr], fx_issued_only[]
--   2_ADOPTED_SUSPECT           fx_adopted[C,A,M,S,F,P,Q,+dpr],
--                               fx_issue_race[C,A,+dpr],
--                               fx_refreshed[C,A,M,+dpr,+refreshed]
--   3_MULTI_DPR_SUSPECT         fx_multi[X,+dpr]
--   anomaly_claimed_without_otp fx_no_otp[+dpr]
--   anomaly_unclaimed_prelogin  fx_odd[C]
--   anonymous_literal           anonymous[]
--   browser_uuid                0b6f3c1e-…[+dpr], cohortA-…[]
--   clean                       n=2 (fx_clean, fx_skew) — ids not listed
--   recreated_after_login       fx_recreated[+dpr]
--   unadoptable_case_variant    FX_Mixed[]
-- ============================================================

BEGIN;

-- ---------- email_otps (emails are fake; the local part is the id) ----------
INSERT INTO email_otps (email, code_hash, issued_at, expires_at, consumed_at) VALUES
  ('fx_clean@nyu.edu',     'x', '2026-09-01 11:59:00+00', '2026-09-01 12:09:00+00', '2026-09-01 12:00:00+00'),
  ('fx_skew@nyu.edu',      'x', '2026-09-01 11:59:00+00', '2026-09-01 12:09:00+00', '2026-09-01 12:00:00+00'),
  ('fx_adopted@nyu.edu',   'x', '2026-09-01 11:59:00+00', '2026-09-01 12:09:00+00', '2026-09-01 12:00:00+00'),
  -- attacker made a code get ISSUED a day early (never consumed); the real
  -- owner logged in at T. Using min(issued_at) would wrongly call this clean.
  ('fx_issue_race@nyu.edu','x', '2026-08-31 12:00:00+00', '2026-08-31 12:10:00+00', NULL),
  ('fx_issue_race@nyu.edu','x', '2026-09-01 11:59:00+00', '2026-09-01 12:09:00+00', '2026-09-01 12:00:00+00'),
  ('fx_refreshed@nyu.edu', 'x', '2026-09-01 11:59:00+00', '2026-09-01 12:09:00+00', '2026-09-01 12:00:00+00'),
  ('fx_issued_only@nyu.edu','x','2026-09-01 11:59:00+00', '2026-09-01 12:09:00+00', NULL),
  ('fx_recreated@nyu.edu', 'x', '2026-09-01 11:59:00+00', '2026-09-01 12:09:00+00', '2026-09-01 12:00:00+00'),
  ('fx_odd@nyu.edu',       'x', '2026-09-01 11:59:00+00', '2026-09-01 12:09:00+00', '2026-09-01 12:00:00+00'),
  ('fx_multi@nyu.edu',     'x', '2026-09-01 11:59:00+00', '2026-09-01 12:09:00+00', '2026-09-01 12:00:00+00');

-- ---------- students ----------
INSERT INTO students (student_id, email, profile, parsed_dpr, created_at, updated_at) VALUES
  -- legit: created right after the verified login
  ('fx_clean',      'fx_clean@nyu.edu',      '{}', '{}', '2026-09-01 12:00:01+00', '2026-09-01 12:05:00+00'),
  -- legit, DB clock 2 s behind the app clock (inside the 5 s tolerance)
  ('fx_skew',       'fx_skew@nyu.edu',       NULL, NULL, '2026-09-01 11:59:58+00', '2026-09-01 12:00:00+00'),
  -- planted two days before the owner's first login, then adopted
  ('fx_adopted',    'fx_adopted@nyu.edu',    '{}', '{}', '2026-08-30 12:00:00+00', '2026-09-01 12:00:01+00'),
  ('fx_issue_race', 'fx_issue_race@nyu.edu', '{}', '{}', '2026-08-31 13:00:00+00', '2026-09-01 12:00:01+00'),
  ('fx_refreshed',  'fx_refreshed@nyu.edu',  '{}', '{}', '2026-08-30 12:00:00+00', '2026-09-03 12:00:00+00'),
  -- planted, owner never logged in → adopted on first login
  ('fx_unclaimed',  NULL,                    '{}', '{}', '2026-08-30 12:00:00+00', '2026-08-30 12:00:00+00'),
  ('fx_issued_only',NULL,                    NULL, NULL, '2026-08-30 12:00:00+00', '2026-08-30 12:00:00+00'),
  -- legit: self-serve delete at T+4d, cookie still valid, re-onboarded at T+5d
  ('fx_recreated',  NULL,                    '{}', '{}', '2026-09-06 12:00:00+00', '2026-09-06 12:00:00+00'),
  -- email set but no OTP record at all
  ('fx_no_otp',     'fx_no_otp@nyu.edu',     '{}', '{}', '2026-08-30 12:00:00+00', '2026-08-30 12:00:00+00'),
  -- unclaimed although the id has logged in, yet created before that login
  ('fx_odd',        NULL,                    NULL, NULL, '2026-08-30 12:00:00+00', '2026-08-30 12:00:00+00'),
  ('anonymous',     NULL,                    NULL, NULL, '2026-08-01 12:00:00+00', '2026-08-01 12:00:00+00'),
  ('0b6f3c1e-6d1a-4c3e-9a51-2f0f6c8d1e77', NULL, '{}', '{}', '2026-08-01 12:00:00+00', '2026-08-01 12:00:00+00'),
  ('cohortA-1777000000000-abcd1234', NULL,   NULL, NULL, '2026-08-01 12:00:00+00', '2026-08-01 12:00:00+00'),
  ('FX_Mixed',      NULL,                    NULL, NULL, '2026-08-01 12:00:00+00', '2026-08-01 12:00:00+00'),
  -- legit login, but a second (foreign) DPR was planned under the id later
  ('fx_multi',      'fx_multi@nyu.edu',      '{}', '{}', '2026-09-01 12:00:01+00', '2026-09-05 12:00:00+00');

-- ---------- audit_log ----------
INSERT INTO audit_log (student_id, pending_mutation_id, field, before, after, confirmed_at) VALUES
  ('fx_clean',      'bootstrap-1',   'homeSchool', NULL, '"cas"', '2026-09-01 12:01:00+00'),
  ('fx_adopted',    'bootstrap-2',   'homeSchool', NULL, '"cas"', '2026-08-30 12:00:00+00'),
  -- confirm_profile_update-style id (no route prefix) still trips A
  ('fx_issue_race', 'pm_3',        'homeSchool', NULL, '"cas"', '2026-08-31 13:00:00+00'),
  ('fx_refreshed',  'visa-4',        'visaStatus', '"domestic"', '"f1"', '2026-08-30 12:30:00+00'),
  ('fx_refreshed',  'dpr_refresh_5', 'dpr_refresh', NULL, '{}', '2026-09-03 12:00:00+00'),
  -- a post-login confirm is legitimate
  ('fx_clean',      'pm_6',          'visaStatus', '"domestic"', '"f1"', '2026-09-01 12:06:00+00');

-- ---------- chat / summaries / schedules / prefs / pending ----------
INSERT INTO chat_messages (student_id, role, content, created_at) VALUES
  ('fx_clean',     'user', 'synthetic', '2026-09-01 12:02:00+00'),
  ('fx_adopted',   'user', 'synthetic', '2026-08-30 12:01:00+00'),
  ('fx_refreshed', 'user', 'synthetic', '2026-08-30 12:01:00+00');

INSERT INTO session_summaries (student_id, date, summary, created_at) VALUES
  ('fx_clean',   '2026-09-01', 'synthetic', '2026-09-01 12:03:00+00'),
  ('fx_adopted', '2026-08-30', 'synthetic', '2026-08-30 12:02:00+00');

INSERT INTO forward_schedules (student_id, schedule, state, dpr_fingerprint, computed_at, superseded_at) VALUES
  ('fx_clean',   '{}', 'feasible', 'fp', '2026-09-01 12:04:00+00', NULL),
  ('fx_adopted', '{}', 'feasible', 'fp', '2026-08-30 12:03:00+00', '2026-09-02 00:00:00+00'),
  ('fx_adopted', '{}', 'feasible', 'fp', '2026-09-02 00:00:00+00', NULL),
  ('fx_multi',   '{}', 'feasible', 'fp-own',     '2026-09-01 12:04:00+00', '2026-09-05 12:00:00+00'),
  ('fx_multi',   '{}', 'feasible', 'fp-foreign', '2026-09-05 12:00:00+00', NULL);

INSERT INTO schedule_preferences (student_id, preferences, updated_at) VALUES
  ('fx_clean',   '{}', '2026-09-01 12:05:00+00'),
  ('fx_adopted', '{}', '2026-08-30 12:04:00+00');

INSERT INTO pending_mutations (pending_mutation_id, student_id, mutations, created_at, expires_at) VALUES
  ('pm-1', 'fx_adopted', '[]', '2026-08-30 12:05:00+00', '2026-08-30 12:15:00+00');

COMMIT;
