-- Files attached in the AI assistant panel (docs/ASSISTANT_ATTACHMENTS.md): which roles may attach and which types, one row.
-- MySQL 8 / TiDB dialect of migrations/004_assistant_attachments.sql.
create table if not exists bridge_assistant_attachment_settings (
  id smallint not null default 1 primary key,
  roles json not null,
  types json not null,
  updated_by varchar(191),
  updated_at datetime(6) not null default current_timestamp(6),
  constraint bridge_assistant_attachment_settings_id_check check (id = 1)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_bin;
