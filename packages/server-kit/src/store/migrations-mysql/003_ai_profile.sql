-- The AI employee's profile (docs/AI_EMPLOYEE_PROFILE.md): one row per version, the current profile = the highest version.
-- Restoring an old version writes a new one. MySQL 8 / TiDB dialect of migrations/003_ai_profile.sql.
create table if not exists bridge_ai_profile_version (
  version integer not null primary key,
  profile json not null,
  updated_by varchar(191),
  reason text,
  created_at datetime(6) not null default current_timestamp(6),
  constraint bridge_ai_profile_version_version_check check (version > 0)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_bin;
