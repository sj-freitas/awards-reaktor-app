alter table nominees add column picture_url text;

create table session_attendees (
  session_id uuid not null references sessions (id) on delete cascade,
  email text not null,
  primary key (session_id, email)
);
alter table session_attendees enable row level security;

alter table sessions drop constraint sessions_stage_check;
alter table sessions add constraint sessions_stage_check check (stage in ('lobby', 'waiting', 'voting', 'closed', 'winner', 'finished'));
