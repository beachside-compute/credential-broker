CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleting` integer DEFAULT false NOT NULL
);
