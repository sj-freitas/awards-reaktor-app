alter table sessions drop constraint sessions_stage_check;
alter table sessions add constraint sessions_stage_check check (stage in ('lobby', 'waiting', 'voting', 'closed', 'finished'));
alter table sessions alter column stage set default 'lobby';
