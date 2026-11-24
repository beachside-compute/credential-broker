CREATE TABLE `alert_destinations` (
	`identity` text PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`config` text NOT NULL,
	`host` text NOT NULL,
	`header_names` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_alert_at` integer,
	`pending_trips` integer DEFAULT 0 NOT NULL,
	`pending_labels` text DEFAULT '[]' NOT NULL,
	`last_delivery_at` integer,
	`last_status` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_destinations_id_unique` ON `alert_destinations` (`id`);--> statement-breakpoint
CREATE TABLE `canaries` (
	`id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`label` text,
	`note` text,
	`integrations` text NOT NULL,
	`created_at` integer NOT NULL,
	`trips` integer DEFAULT 0 NOT NULL,
	`first_tripped_at` integer,
	`last_tripped_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canaries_hash_unique` ON `canaries` (`hash`);--> statement-breakpoint
CREATE TABLE `canary_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canary_id` text NOT NULL,
	`event` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`canary_id`) REFERENCES `canaries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `canary_events_canary` ON `canary_events` (`canary_id`,`at`);