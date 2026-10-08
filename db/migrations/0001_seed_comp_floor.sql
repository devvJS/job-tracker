-- Custom SQL migration file, put your code below! --
-- comp_floor is the only setting in this build (brief: no settings endpoint).
INSERT INTO "settings" ("key", "value") VALUES ('comp_floor', '150000'::jsonb) ON CONFLICT ("key") DO NOTHING;
