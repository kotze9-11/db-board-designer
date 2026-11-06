-- DB Board Designer: database setup
-- Paste all of this into Supabase > SQL Editor > New query, then click "Run".

-- 1. Saved boards. Each person can only see and change their own boards.
create table if not exists public.boards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null default 'New board',
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists boards_user_updated on public.boards (user_id, updated_at desc);
alter table public.boards enable row level security;

drop policy if exists "Read own boards" on public.boards;
drop policy if exists "Add own boards" on public.boards;
drop policy if exists "Change own boards" on public.boards;
drop policy if exists "Delete own boards" on public.boards;
create policy "Read own boards"   on public.boards for select using (auth.uid() = user_id);
create policy "Add own boards"    on public.boards for insert with check (auth.uid() = user_id);
create policy "Change own boards" on public.boards for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Delete own boards" on public.boards for delete using (auth.uid() = user_id);

-- 2. A log of photo reads, used for the daily limit per person.
--    No policies on purpose: only the server function can read or write it.
create table if not exists public.photo_reads (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  ok boolean not null default false,
  tokens_in integer,
  tokens_out integer
);
create index if not exists photo_reads_user_time on public.photo_reads (user_id, created_at desc);
alter table public.photo_reads enable row level security;
