create table sessions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  stage text not null default 'waiting' check (stage in ('waiting', 'voting', 'closed', 'finished')),
  current_position int not null default 0,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table categories (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions (id) on delete cascade,
  position int not null,
  name text not null,
  unique (session_id, position)
);

create table nominees (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references categories (id) on delete cascade,
  position int not null,
  name text not null,
  unique (category_id, position)
);
create unique index nominees_category_name_idx on nominees (category_id, lower(name));

create table votes (
  category_id uuid not null references categories (id) on delete cascade,
  nominee_id uuid not null references nominees (id) on delete cascade,
  voter_id text not null,
  updated_at timestamptz not null default now(),
  primary key (category_id, voter_id)
);
create index votes_nominee_idx on votes (nominee_id);

-- The server connects as the table owner. RLS with no policies keeps votes and
-- results out of reach of Supabase's public REST API.
alter table sessions enable row level security;
alter table categories enable row level security;
alter table nominees enable row level security;
alter table votes enable row level security;
