-- Private chat for Bernad and Annecke.
-- Paste all of this into Supabase > SQL Editor > New query, and press Run. Safe to run more than once.

-- Who may use the chat
create table if not exists public.chat_members (
  email text primary key,
  display_name text not null
);
insert into public.chat_members (email, display_name) values
  ('kotzeb@yahoo.com', 'Bernad'),
  ('anneckekotze@gmail.com', 'Annecke')
on conflict (email) do update set display_name = excluded.display_name;

-- The messages
create table if not exists public.chat_messages (
  id bigint generated always as identity primary key,
  sender_email text not null default lower(auth.email()),
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_created_at on public.chat_messages (created_at);

-- Only the two members can see or send anything
alter table public.chat_members enable row level security;
alter table public.chat_messages enable row level security;

create or replace function public.is_chat_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.chat_members where email = lower(auth.email()));
$$;

drop policy if exists "members see members" on public.chat_members;
create policy "members see members" on public.chat_members
  for select to authenticated using (public.is_chat_member());

drop policy if exists "members read messages" on public.chat_messages;
create policy "members read messages" on public.chat_messages
  for select to authenticated using (public.is_chat_member());

drop policy if exists "members send messages" on public.chat_messages;
create policy "members send messages" on public.chat_messages
  for insert to authenticated with check (public.is_chat_member() and sender_email = lower(auth.email()));

drop policy if exists "members delete own messages" on public.chat_messages;
create policy "members delete own messages" on public.chat_messages
  for delete to authenticated using (public.is_chat_member() and sender_email = lower(auth.email()));

-- Live updates: new messages appear without refreshing
do $$ begin
  alter publication supabase_realtime add table public.chat_messages;
exception when duplicate_object then null; end $$;
