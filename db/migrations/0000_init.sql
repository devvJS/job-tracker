CREATE TABLE "application_contacts" (
	"application_id" text NOT NULL,
	"contact_id" text NOT NULL,
	CONSTRAINT "application_contacts_application_id_contact_id_pk" PRIMARY KEY("application_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" text PRIMARY KEY NOT NULL,
	"company" text NOT NULL,
	"role_title" text NOT NULL,
	"posting_url" text,
	"job_id" text,
	"posting_status" text,
	"posting_verified_at" date,
	"jd_snapshot_path" text,
	"jd_snapshot" text,
	"work_arrangement" text NOT NULL,
	"location" text,
	"detroit_metro" boolean,
	"onsite_requirement" text,
	"remote_scope" text,
	"move_timing_ok" text,
	"comp_min" integer,
	"comp_max" integer,
	"comp_source" text,
	"meets_floor" boolean,
	"equity_bonus_notes" text,
	"track" text,
	"company_archetype" text,
	"company_stage" text,
	"industry" text,
	"mission_interest" text[],
	"fit" jsonb,
	"materials" jsonb,
	"source" text,
	"source_detail" text,
	"connection" text,
	"referral" text,
	"status" text NOT NULL,
	"priority" text,
	"next_action" text,
	"next_action_due" date,
	"follow_up_date" date,
	"discovered_at" date NOT NULL,
	"applied_at" date,
	"closed_at" date,
	"closed_reason" text,
	"notes" text,
	"project_thread_url" text,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "applications_posting_url_unique" UNIQUE("posting_url")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"company" text,
	"role" text,
	"relationship" text,
	"linkedin_url" text,
	"email" text,
	"last_contact_at" date,
	"notes" text,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" text NOT NULL,
	"at" timestamp (3) with time zone NOT NULL,
	"type" text NOT NULL,
	"note" text,
	"by" text NOT NULL,
	"from_status" text,
	"to_status" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_contacts" ADD CONSTRAINT "application_contacts_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_contacts" ADD CONSTRAINT "application_contacts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applications_status_idx" ON "applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "applications_next_action_due_idx" ON "applications" USING btree ("next_action_due");--> statement-breakpoint
CREATE INDEX "applications_follow_up_date_idx" ON "applications" USING btree ("follow_up_date");--> statement-breakpoint
CREATE INDEX "applications_updated_at_idx" ON "applications" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "events_application_id_at_idx" ON "events" USING btree ("application_id","at");