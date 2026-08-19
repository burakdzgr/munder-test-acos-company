-- D4 (27 §12): "per-workspace additions come from project settings via a
-- generated include". The doc names project settings as the source of the
-- per-project egress allowlist; no such column existed, so a workspace could
-- only ever reach the built-in package registries and every project API was
-- unreachable. Additive: nullable-free with a `{}` default, so existing rows
-- keep working untouched.
ALTER TABLE "projects" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
