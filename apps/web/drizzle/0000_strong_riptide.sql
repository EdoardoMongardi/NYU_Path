CREATE TYPE "public"."cohort" AS ENUM('alpha', 'beta', 'invite', 'public', 'limited');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" text NOT NULL,
	"pending_mutation_id" text NOT NULL,
	"field" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cohort_assignments" (
	"user_id" text PRIMARY KEY NOT NULL,
	"cohort" "cohort" NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by" text
);
--> statement-breakpoint
CREATE TABLE "email_otps" (
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "email_otps_email_issued_at_pk" PRIMARY KEY("email","issued_at")
);
--> statement-breakpoint
CREATE TABLE "session_summaries" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" text NOT NULL,
	"date" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "students" (
	"student_id" text PRIMARY KEY NOT NULL,
	"email" text,
	"parsed_transcript" jsonb,
	"declared_programs" jsonb DEFAULT '[]' NOT NULL,
	"visa_status" text,
	"catalog_year" text,
	"home_school" text,
	"flags" jsonb DEFAULT '[]' NOT NULL,
	"profile" jsonb,
	"last_session_date" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "students_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_student_id_students_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("student_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_summaries" ADD CONSTRAINT "session_summaries_student_id_students_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("student_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_student_idx" ON "audit_log" USING btree ("student_id","confirmed_at");--> statement-breakpoint
CREATE INDEX "email_otps_email_idx" ON "email_otps" USING btree ("email");--> statement-breakpoint
CREATE INDEX "session_summaries_student_idx" ON "session_summaries" USING btree ("student_id","id");