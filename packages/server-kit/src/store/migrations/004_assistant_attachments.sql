-- Files attached in the AI assistant panel (docs/ASSISTANT_ATTACHMENTS.md, /bridge/v1/admin/assistant/attachment-settings):
-- which roles may attach and which types, one row. No row = the defaults (DEFAULT_ATTACHMENT_ROLES within the manifest roles,
-- every type). The files themselves are never stored (converted in memory); the audit log keeps counts, types and sizes only.
create table if not exists bridge_assistant_attachment_settings (
  id smallint primary key default 1 check (id = 1),
  roles jsonb not null,
  types jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);
