-- External connectors of the AI employee (docs/AI_EMPLOYEE_PROFILE.md section 3): connectors (definition + sealed secret +
-- hint), rules, the run log (ids, status, code and timing only) and one row of state. MySQL 8 / TiDB dialect of
-- migrations/005_connectors.sql; run ids are AUTO_INCREMENT with TiDB's AUTO_ID_CACHE=1 (allocated in increasing order).
create table if not exists bridge_connector (
  id varchar(191) not null primary key,
  definition json not null,
  secret_sealed text,
  secret_hint varchar(64),
  updated_by varchar(191),
  updated_at datetime(6) not null default current_timestamp(6)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_bin;

create table if not exists bridge_connector_rule (
  id varchar(191) not null primary key,
  definition json not null,
  updated_by varchar(191),
  updated_at datetime(6) not null default current_timestamp(6)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_bin;

create table if not exists bridge_connector_run (
  id bigint not null auto_increment primary key,
  rule_id varchar(191),
  connector_id varchar(191) not null,
  operation_id varchar(191) not null,
  trigger_kind varchar(32) not null,
  trigger_ref varchar(191),
  actor varchar(191),
  status varchar(32) not null,
  code varchar(191),
  http_status integer,
  duration_ms integer,
  proposal_id varchar(191),
  created_at datetime(6) not null default current_timestamp(6),
  key bridge_connector_run_created (created_at, id),
  key bridge_connector_run_connector (connector_id, id),
  key bridge_connector_run_rule (rule_id, id)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_bin /*T![auto_id_cache] AUTO_ID_CACHE=1 */;

create table if not exists bridge_connector_state (
  id smallint not null default 1 primary key,
  stopped boolean not null default false,
  stopped_by varchar(191),
  stopped_at datetime(6),
  event_cursor bigint not null default 0,
  cron_minute varchar(32),
  constraint bridge_connector_state_id_check check (id = 1)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_bin;
