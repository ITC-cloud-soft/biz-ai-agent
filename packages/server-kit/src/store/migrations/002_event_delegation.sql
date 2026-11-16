-- Per-event delegations (POST /bridge/v1/delegations { event: { id } }): the token is bound to the business event that
-- triggered the automatic task; it is valid only while that event's rule (hooks.eventDelegations) still holds.
alter table bridge_delegation add column if not exists source_event_id bigint references bridge_event(id);
