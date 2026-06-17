CREATE TABLE "pending_mutations" (
	"pending_mutation_id" text PRIMARY KEY NOT NULL,
	"student_id" text NOT NULL,
	"mutations" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_mutations" ADD CONSTRAINT "pending_mutations_student_id_students_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("student_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_mutations_student_idx" ON "pending_mutations" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "pending_mutations_expires_idx" ON "pending_mutations" USING btree ("expires_at");