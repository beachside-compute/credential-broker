CREATE TABLE `platform_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant` text NOT NULL,
	`actor` text NOT NULL,
	`operation` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`outcome` text
);
