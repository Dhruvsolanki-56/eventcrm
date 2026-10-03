ALTER TABLE encounters ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE encounters ADD COLUMN open_question TEXT NOT NULL DEFAULT '';
ALTER TABLE encounters ADD COLUMN promised_next_step TEXT NOT NULL DEFAULT '';
ALTER TABLE encounters ADD COLUMN changed_since_last TEXT NOT NULL DEFAULT '';
