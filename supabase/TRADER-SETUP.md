# Crypto Bot setup (about 10 minutes)

Page: https://kotze9-11.github.io/designer/trader/  (only kotzeb@yahoo.com can use it)

## 1. Turn on the timer tools
Supabase > Database > Extensions. Search **pg_cron** and switch it on. Search **pg_net** and switch it on.

## 2. Create the tables and the 15-minute timer
Supabase > SQL Editor > New query. Paste everything from `supabase/trader.sql` and press **Run**.

## 3. Add the bot
Supabase > Edge Functions > Deploy a new function > Via Editor.
Name it exactly `trade-bot`, paste everything from `supabase/functions/trade-bot/index.ts`, press **Deploy**.
Then in the function's settings turn **off** "Verify JWT" and save.
The Claude key (ANTHROPIC_API_KEY) is already in your Secrets from the DB board app.

## 4. Test
Open the page, sign in, press **Check now**. After 10–20 seconds you should see Claude's first decision.
From then on it runs every 15 minutes by itself, in practice mode with R5,000 of pretend money.

## Later: real money (only after a few weeks of practice)
1. On VALR: Account > API Keys > create a key with **Trade** permission only. Never tick Withdraw. If VALR offers it, lock it to trading only.
2. Supabase > Edge Functions > Secrets: add `VALR_API_KEY` and `VALR_API_SECRET`. Never paste them into a chat.
3. Put only the money you want the bot to use into VALR (rand).
4. On the bot page press **Switch to real money** and type LIVE.

## Costs
Claude is asked about 96 times a day with the small, cheap model (claude-haiku-5-5): roughly R1–R3 a day.
Set a monthly spend limit on console.anthropic.com.

# Stock Bot (US + JSE, practice money)
Page: https://kotze9-11.github.io/designer/stocks/
1. SQL Editor > New query: paste `supabase/stocks.sql`, press Run.
2. Edge Functions > Deploy a new function > Via Editor: name it `stock-bot`, paste `supabase/functions/stock-bot/index.ts`, Deploy. Turn OFF "Verify JWT".
3. Open the page, press Check now (only does something while the US or JSE market is open).
