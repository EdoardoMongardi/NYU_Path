DROP TABLE "cohort_assignments" CASCADE;--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "parsed_transcript";--> statement-breakpoint
DROP TYPE "public"."cohort";