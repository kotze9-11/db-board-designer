-- Stock bot. Paste into Supabase > SQL Editor > New query, press Run. Safe to run more than once.
-- Needs trader.sql to have been run first (it uses the same owner check and secret key).

create table if not exists public.stock_settings (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default true,
  mode text not null default 'paper' check (mode in ('paper')),   -- real money comes later
  max_trade_zar numeric not null default 1000,      -- most it spends in one buy
  daily_loss_limit_zar numeric not null default 1500,
  max_trades_per_day int not null default 4,
  min_confidence numeric not null default 0.65,
  min_minutes_between int not null default 60,
  max_holdings int not null default 5,               -- most different shares owned at once
  watchlist text[] not null default array['SPY','QQQ','AAPL','MSFT','NVDA','AMZN','STX40.JO','NPN.JO','CPI.JO','FSR.JO','SBK.JO'],
  updated_at timestamptz not null default now()
);
insert into public.stock_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.stock_paper (
  id int primary key default 1 check (id = 1),
  cash_zar numeric not null default 20000,
  start_zar numeric not null default 20000,
  started_at timestamptz not null default now()
);
insert into public.stock_paper (id) values (1) on conflict (id) do nothing;

create table if not exists public.stock_positions (
  symbol text primary key,
  shares numeric not null,
  cost_zar numeric not null,          -- what was paid in total, in rand
  opened_at timestamptz not null default now()
);

create table if not exists public.stock_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  symbol text,
  action text not null,        -- buy, sell, hold
  status text not null,        -- done, skipped, error
  shares numeric,
  amount_zar numeric,
  price_zar numeric,           -- price per share in rand
  confidence numeric,
  reason text,
  value_zar numeric,           -- cash + shares, in rand, after this check
  cash_zar numeric
);
create index if not exists stock_log_at on public.stock_log (at desc);

alter table public.stock_settings enable row level security;
alter table public.stock_paper enable row level security;
alter table public.stock_positions enable row level security;
alter table public.stock_log enable row level security;

drop policy if exists "owner reads stock settings" on public.stock_settings;
create policy "owner reads stock settings" on public.stock_settings for select using (public.trader_is_owner());
drop policy if exists "owner changes stock settings" on public.stock_settings;
create policy "owner changes stock settings" on public.stock_settings for update using (public.trader_is_owner()) with check (public.trader_is_owner());
drop policy if exists "owner reads stock paper" on public.stock_paper;
create policy "owner reads stock paper" on public.stock_paper for select using (public.trader_is_owner());
drop policy if exists "owner reads positions" on public.stock_positions;
create policy "owner reads positions" on public.stock_positions for select using (public.trader_is_owner());
drop policy if exists "owner reads stock log" on public.stock_log;
create policy "owner reads stock log" on public.stock_log for select using (public.trader_is_owner());

-- Timer: every 30 minutes on weekdays (the bot itself skips when markets are closed)
select cron.unschedule(jobid) from cron.job where jobname = 'stock-bot';
select cron.schedule('stock-bot', '5,35 * * * 1-5', $$
  select net.http_post(
    url := 'https://lvsgxundjdiiydrwzlep.supabase.co/functions/v1/stock-bot',
    headers := jsonb_build_object('Content-Type','application/json','x-bot-token',(select token from public.trader_secret where id = 1)),
    body := '{"run":"timer"}'::jsonb,
    timeout_milliseconds := 120000
  ) $$);
