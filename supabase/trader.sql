-- Crypto trading bot. Paste into Supabase > SQL Editor > New query, press Run.
-- Safe to run more than once.
-- Before running: make sure pg_cron and pg_net are turned on
-- (Database > Extensions: search "pg_cron" and "pg_net", switch both on).

-- Who owns the bot (only this login can see or change it)
create or replace function public.trader_is_owner() returns boolean
language sql stable as $$ select coalesce(auth.jwt()->>'email','') = 'kotzeb@yahoo.com' $$;

-- Settings (one row)
create table if not exists public.trader_settings (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default true,          -- the big on/off switch
  mode text not null default 'paper' check (mode in ('paper','live')),
  pair text not null default 'BTCZAR',
  max_trade_zar numeric not null default 500,     -- most it spends or sells in one trade
  daily_loss_limit_zar numeric not null default 1000, -- stops for the day after losing this much
  max_trades_per_day int not null default 6,
  min_confidence numeric not null default 0.65,   -- Claude must be at least this sure
  min_minutes_between int not null default 60,    -- rest time between trades
  updated_at timestamptz not null default now()
);
insert into public.trader_settings (id) values (1) on conflict (id) do nothing;

-- Practice wallet (pretend money)
create table if not exists public.trader_paper (
  id int primary key default 1 check (id = 1),
  zar numeric not null default 5000,
  btc numeric not null default 0,
  start_zar numeric not null default 5000,
  started_at timestamptz not null default now()
);
insert into public.trader_paper (id) values (1) on conflict (id) do nothing;

-- Every check, with Claude's reasoning
create table if not exists public.trader_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  mode text not null,
  price numeric,
  action text not null,        -- buy, sell, hold
  status text not null,        -- done, skipped, error
  amount_zar numeric,
  amount_btc numeric,
  confidence numeric,
  reason text,
  value_zar numeric,           -- wallet value (rand + bitcoin) after this check
  zar numeric,
  btc numeric
);
create index if not exists trader_log_at on public.trader_log (at desc);

-- Private key the timer uses to wake the bot (made automatically)
create table if not exists public.trader_secret (
  id int primary key default 1 check (id = 1),
  token text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);
insert into public.trader_secret (id) values (1) on conflict (id) do nothing;

-- Rules: only the owner can see and change; the secret is server-only
alter table public.trader_settings enable row level security;
alter table public.trader_paper enable row level security;
alter table public.trader_log enable row level security;
alter table public.trader_secret enable row level security;

drop policy if exists "owner reads settings" on public.trader_settings;
create policy "owner reads settings" on public.trader_settings for select using (public.trader_is_owner());
drop policy if exists "owner changes settings" on public.trader_settings;
create policy "owner changes settings" on public.trader_settings for update using (public.trader_is_owner()) with check (public.trader_is_owner());
drop policy if exists "owner reads paper" on public.trader_paper;
create policy "owner reads paper" on public.trader_paper for select using (public.trader_is_owner());
drop policy if exists "owner reads log" on public.trader_log;
create policy "owner reads log" on public.trader_log for select using (public.trader_is_owner());

-- Keep the log from growing forever (90 days)
create or replace function public.trader_trim_log() returns void language sql as $$
  delete from public.trader_log where at < now() - interval '90 days' $$;

-- Timer: wake the bot every 15 minutes
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule(jobid) from cron.job where jobname in ('trade-bot','trade-bot-trim');
select cron.schedule('trade-bot', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://lvsgxundjdiiydrwzlep.supabase.co/functions/v1/trade-bot',
    headers := jsonb_build_object('Content-Type','application/json','x-bot-token',(select token from public.trader_secret where id = 1)),
    body := '{"run":"timer"}'::jsonb,
    timeout_milliseconds := 60000
  ) $$);
select cron.schedule('trade-bot-trim', '0 3 * * *', $$ select public.trader_trim_log() $$);
