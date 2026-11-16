-- External connectors of the AI employee (docs/AI_EMPLOYEE_PROFILE.md §3, /bridge/v1/admin/connectors*, /bridge/v1/connectors/*):
-- a connector (its operations inside the definition), its secret sealed with AES-256-GCM (never in clear; the screen shows the
-- hint = the last 4 characters), the rules, the run log (ids, status, code and timing only — never the input or the response)
-- and one row of state (the global stop switch, the event cursor and the last cron minute of the rule engine).
create table if not exists bridge_connector (
  id text primary key,
  definition jsonb not null,
  secret_sealed text,
  secret_hint text,
  updated_by text,
  updated_at timestamptz not null default now()
);
create table if not exists bridge_connector_rule (
  id text primary key,
  definition jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);
create table if not exists bridge_connector_run (
  id bigserial primary key,
  rule_id text,
  connector_id text not null,
  operation_id text not null,
  trigger_kind text not null,
  trigger_ref text,
  actor text,
  status text not null,
  code text,
  http_status integer,
  duration_ms integer,
  proposal_id text,
  created_at timestamptz not null default now()
);
create index if not exists bridge_connector_run_created on bridge_connector_run (created_at desc, id desc);
create table if not exists bridge_connector_state (
  id smallint primary key default 1 check (id = 1),
  stopped boolean not null default false,
  stopped_by text,
  stopped_at timestamptz,
  event_cursor bigint not null default 0,
  cron_minute text
);
