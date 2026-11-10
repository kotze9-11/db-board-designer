-- Notifications for the private chat. Paste into Supabase > SQL Editor > New query, press Run.
-- Safe to run more than once. Run chat.sql first.

-- Each device that turned on notifications
create table if not exists public.chat_push_subs (
  endpoint text primary key,
  email text not null,
  sub jsonb not null,
  created_at timestamptz not null default now()
);
-- The server's own notification keys (created automatically on first use)
create table if not exists public.chat_vapid (
  id int primary key,
  public_key text not null,
  private_key text not null
);
-- Locked down: only the chat-push server function (service role) can touch these
alter table public.chat_push_subs enable row level security;
alter table public.chat_vapid enable row level security;
