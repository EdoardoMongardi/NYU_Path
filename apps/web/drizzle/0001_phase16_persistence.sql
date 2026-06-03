CREATE TABLE "chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"thinking_text" text,
	"tool_invocations" jsonb,
	"validator_violations" jsonb,
	"pending_mutation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forward_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" text NOT NULL,
	"schedule" jsonb NOT NULL,
	"state" text NOT NULL,
	"dpr_fingerprint" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "schedule_preferences" (
	"student_id" text PRIMARY KEY NOT NULL,
	"preferences" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "parsed_dpr" jsonb;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_student_id_students_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("student_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forward_schedules" ADD CONSTRAINT "forward_schedules_student_id_students_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("student_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_preferences" ADD CONSTRAINT "schedule_preferences_student_id_students_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("student_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_messages_student_idx" ON "chat_messages" USING btree ("student_id","id");--> statement-breakpoint
CREATE INDEX "forward_schedules_student_active_idx" ON "forward_schedules" USING btree ("student_id","computed_at");