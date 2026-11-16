-- Per-event delegations (POST /bridge/v1/delegations { event: { id } }): the token is bound to the business event that
-- triggered the automatic task; it is valid only while that event's rule (hooks.eventDelegations) still holds.
-- MySQL 8 / TiDB dialect of migrations/002_event_delegation.sql. Two statements: TiDB does not add a column and a foreign
-- key on it in one ALTER. Run again after a stop between them, the first is skipped (duplicate column: see migrateMysql).
alter table bridge_delegation add column source_event_id bigint null;
alter table bridge_delegation add constraint bridge_delegation_source_event_id_fkey foreign key (source_event_id) references bridge_event (id);
