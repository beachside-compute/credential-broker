CREATE TABLE `data_keys` (
	`version` text PRIMARY KEY NOT NULL,
	`wrapped` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `role_keys` (
	`role` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_keys_hash_unique` ON `role_keys` (`hash`);--> statement-breakpoint
CREATE TABLE `tenant` (
	`id` text PRIMARY KEY NOT NULL,
	`config` text,
	`created_at` integer NOT NULL
);
