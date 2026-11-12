-- Run once in Supabase > SQL Editor (adds coin choice to an existing bot)
alter table public.trader_log add column if not exists pair text;
alter table public.trader_paper add column if not exists coin text;
