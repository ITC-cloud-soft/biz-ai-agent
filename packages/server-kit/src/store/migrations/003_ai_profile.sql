-- The AI employee's profile (docs/AI_EMPLOYEE_PROFILE.md, GET /bridge/v1/ai-profile, /bridge/v1/admin/ai-profile*): one row per
-- version, the current profile = the highest version. Restoring an old version writes a new one. The audit log keeps the version
-- number only (never the text).
create table if not exists bridge_ai_profile_version (
  version integer primary key check (version > 0),
  profile jsonb not null,
  updated_by text,
  reason text,
  created_at timestamptz not null default now()
);
