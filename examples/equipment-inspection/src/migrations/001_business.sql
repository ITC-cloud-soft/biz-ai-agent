-- equipment-inspection: the business tables (users, sessions, equipment, inspections, repair requests, approvals).
-- The Bridge tables (identity, link codes, delegations, events, ...) come from @dsh-bridge/server-kit (bridge_* tables).

create table if not exists app_user (
  id uuid primary key default gen_random_uuid(),
  login_id text not null unique,
  display_name text not null,
  role text not null check (role in ('admin', 'manager', 'inspector')),
  active boolean not null default true,
  password_hash text not null,
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists app_session (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table if not exists equipment (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  location text not null default '',
  category text not null default 'general',
  interval_days integer not null check (interval_days between 1 and 3650),
  next_due_on date not null,
  assignee_user_id uuid references app_user(id),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists inspection (
  id uuid primary key default gen_random_uuid(),
  equipment_id uuid not null references equipment(id),
  inspector_user_id uuid not null references app_user(id),
  inspected_on date not null,
  result text not null check (result in ('ok', 'ng')),
  note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists inspection_by_day on inspection (inspected_on);

-- one inspection.overdue event per (equipment, due date): the scan is idempotent
create table if not exists overdue_notice (
  equipment_id uuid not null references equipment(id),
  due_on date not null,
  event_id bigint,
  primary key (equipment_id, due_on)
);

create table if not exists repair_request (
  id uuid primary key default gen_random_uuid(),
  equipment_id uuid not null references equipment(id),
  requested_by uuid not null references app_user(id),
  estimated_cost integer not null check (estimated_cost >= 0),
  detail text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

create table if not exists approval (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null,
  subject_id uuid not null,
  required_role text not null,
  requested_by uuid not null references app_user(id),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  expires_at timestamptz not null,
  decided_by uuid references app_user(id),
  decided_at timestamptz,
  decision_channel text,
  comment text,
  created_at timestamptz not null default now()
);
