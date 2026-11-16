-- @dsh-bridge/server-kit: the Bridge tables (identity, link codes, personal bots, delegations, assistant tickets, events,
-- notification preferences / deliveries, approval card deliveries, reports, proposals, throttles, audit).
-- Employee ids are the business system's own ids, stored as text (no foreign key into the business schema).

create table if not exists bridge_setting (
  key text primary key,
  value text not null
);

create table if not exists bridge_throttle_hit (
  id bigserial primary key,
  bucket text not null,
  key text not null,
  at timestamptz not null default now()
);
create index if not exists bridge_throttle_hit_lookup on bridge_throttle_hit (bucket, key, at);
create index if not exists bridge_throttle_hit_bucket on bridge_throttle_hit (bucket, at);

create table if not exists bridge_audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  target text,
  detail jsonb not null default '{}'
);
create index if not exists bridge_audit_log_action on bridge_audit_log (action, at);

create table if not exists bridge_identity (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  platform text not null,
  team_id text not null default '',
  external_id text not null,
  bot_id text,
  method text not null default 'link_code',
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default clock_timestamp(),
  unlinked_at timestamptz
);
create unique index if not exists bridge_identity_active on bridge_identity (platform, team_id, external_id) where unlinked_at is null;
create index if not exists bridge_identity_user on bridge_identity (user_id) where unlinked_at is null;

create table if not exists bridge_link_code (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  code_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz
);
create unique index if not exists bridge_link_code_live on bridge_link_code (code_hash) where used_at is null and revoked_at is null;

create table if not exists bridge_personal_bot (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  platform text not null,
  bot_id text not null,
  created_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  unique (platform, bot_id)
);

create table if not exists bridge_assistant_ticket (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id text not null,
  session_id text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table if not exists bridge_delegation (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id text not null,
  identity_id uuid references bridge_identity(id),
  session_id text,
  ticket_id uuid references bridge_assistant_ticket(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists bridge_delegation_identity on bridge_delegation (identity_id) where revoked_at is null;

-- transactional outbox: written in the same transaction as the business change
create table if not exists bridge_event (
  id bigserial primary key,
  event_type text not null,
  aggregate_type text not null,
  aggregate_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists bridge_notification_pref (
  user_id text primary key,
  types jsonb not null default '{}',
  quiet_hours jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists bridge_delivery (
  event_id bigint not null references bridge_event(id),
  user_id text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped', 'undeliverable')),
  channel text,
  message_ref text,
  error_code text,
  resolved_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create table if not exists bridge_approval_delivery (
  id uuid primary key,
  approval_id text not null,
  user_id text not null,
  identity_id uuid not null references bridge_identity(id),
  token_hash text not null unique,
  status text not null default 'issued' check (status in ('issued', 'used', 'revoked', 'locked')),
  wrong_attempts integer not null default 0,
  message_ref text,
  sent_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);
create unique index if not exists bridge_approval_delivery_live on bridge_approval_delivery (approval_id, user_id) where status in ('issued', 'locked');

create table if not exists bridge_report (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  report_date date not null,
  slot text not null,
  sections jsonb not null,
  attention integer not null default 0,
  test boolean not null default false,
  created_by text,
  generated_at timestamptz not null default clock_timestamp()
);
create unique index if not exists bridge_report_scheduled on bridge_report (kind, report_date, slot) where not test;

create table if not exists bridge_proposal (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  payload jsonb not null,
  status text not null default 'pending_review' check (status in ('pending_review', 'accepted', 'rejected')),
  confidence numeric,
  for_user_id text,
  created_via text not null check (created_via in ('service', 'delegation')),
  created_at timestamptz not null default clock_timestamp(),
  decided_by text,
  decided_at timestamptz,
  comment text
);
