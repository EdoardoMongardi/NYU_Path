CREATE TABLE "session_revocations" (
	"student_id" text PRIMARY KEY NOT NULL,
	"revoked_at" timestamp with time zone NOT NULL
);
