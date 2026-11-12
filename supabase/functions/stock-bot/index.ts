// Stock bot: "stock-bot" server function for Supabase. Practice money only (for now).
// Every 30 minutes on weekdays the timer (stocks.sql) wakes it. It:
//   1. checks which markets are open (US and JSE),
//   2. reads prices for the watch list from Yahoo Finance (free, no account),
//   3. asks Claude to buy one share, sell one, or wait,
//   4. checks the safety limits and updates the practice wallet (in rand).
// Secrets: ANTHROPIC_API_KEY (already there). Optional: STOCK_MODEL, STOCK_FEE (default 0.0025 = 0.25%).
// In the function's settings, turn OFF "Verify JWT". It checks the caller itself.
import { createClient } from "jsr:@supabase/supabase-js@2";

const OWNER = "kotzeb@yahoo.com";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bot-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const notes: string[] = [];
const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (a: number, b: number) => (b ? r2(((a - b) / b) * 100) : null);
const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1);

const NAMES: Record<string, string> = {
  SPY: "S&P 500 fund (500 biggest US companies)", QQQ: "Nasdaq 100 fund (big US tech)", AAPL: "Apple",
  MSFT: "Microsoft", NVDA: "Nvidia", AMZN: "Amazon", GOOGL: "Alphabet (Google)", META: "Meta (Facebook)", TSLA: "Tesla",
  "STX40.JO": "Satrix 40 fund (40 biggest JSE companies)", "NPN.JO": "Naspers", "CPI.JO": "Capitec",
  "FSR.JO": "FirstRand", "SBK.JO": "Standard Bank", "MTN.JO": "MTN", "SOL.JO": "Sasol", "AGL.JO": "Anglo American",
};

// ---------- prices (Yahoo Finance) ----------
type Chart = {
  symbol: string; currency: string; price: number; open: boolean; prevClose: number;
  daily: number[]; intraday: number[];
};
async function yahoo(symbol: string, interval: string, range: string) {
  let last = "";
  for (const host of ["query1", "query2"]) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`,
        { headers: { "User-Agent": "Mozilla/5.0 (compatible; stock-bot/1.0)" } });
      if (!r.ok) { last = `${r.status}`; continue; }
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      if (res) return res;
      last = j?.chart?.error?.description || "no data";
    } catch (e) { last = e instanceof Error ? e.message : String(e); }
  }
  throw new Error(`Yahoo ${symbol}: ${last}`);
}
const closes = (res: { indicators?: { quote?: { close?: (number | null)[] }[] } }) =>
  (res?.indicators?.quote?.[0]?.close || []).filter((x): x is number => typeof x === "number" && x > 0);

async function chart(symbol: string, withIntraday: boolean): Promise<Chart> {
  const d = await yahoo(symbol, "1d", "6mo");
  const m = d.meta || {};
  const reg = m.currentTradingPeriod?.regular;
  const now = Date.now() / 1000;
  const open = !!reg && now >= reg.start && now <= reg.end;
  let intraday: number[] = [];
  if (withIntraday && open) {
    try { intraday = closes(await yahoo(symbol, "30m", "5d")); } catch (e) { notes.push(String(e)); }
  }
  return {
    symbol, currency: String(m.currency || ""), price: +m.regularMarketPrice || 0, open,
    prevClose: +(m.chartPreviousClose ?? m.previousClose ?? 0), daily: closes(d), intraday,
  };
}
// rand per one unit of the share's own price (USD, ZAc = SA cents, ZAR)
function toRand(currency: string, usdzar: number) {
  if (currency === "ZAc" || currency === "ZAC") return 0.01;
  if (currency === "ZAR") return 1;
  if (currency === "USD") return usdzar;
  return 0;
}
function rsi(c: number[], n = 14) {
  if (c.length <= n) return null;
  let g = 0, l = 0;
  for (let i = c.length - n; i < c.length; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  return Math.round(l === 0 ? 100 : 100 - 100 / (1 + g / l));
}
function picture(c: Chart, rate: number) {
  const d = c.daily;
  const last = c.price || d[d.length - 1];
  return {
    name: NAMES[c.symbol] || c.symbol,
    market: c.symbol.endsWith(".JO") ? "JSE" : "US",
    market_open_now: c.open,
    price_rand: r2(last * rate),
    change_today_pct: pct(last, c.prevClose),
    change_1w_pct: d.length > 5 ? pct(last, d[d.length - 6]) : null,
    change_1m_pct: d.length > 21 ? pct(last, d[d.length - 22]) : null,
    change_6m_pct: d.length > 1 ? pct(last, d[0]) : null,
    vs_20_day_average_pct: d.length >= 20 ? pct(last, avg(d.slice(-20))) : null,
    vs_50_day_average_pct: d.length >= 50 ? pct(last, avg(d.slice(-50))) : null,
    daily_strength_0_100: rsi(d),
    today_half_hourly_rand: c.intraday.slice(-14).map((x) => Math.round(x * rate * 100) / 100),
  };
}

// ---------- Claude ----------
const SYSTEM = `You are a careful, patient share trader managing a practice portfolio in rand for a South African owner.
You see: which markets are open, a watch list of US and JSE shares/funds with recent price moves, the cash, the shares already owned (with profit or loss), the safety limits and your recent decisions.
Each time, make ONE decision: buy one share/fund, sell one you own, or hold.
Principles:
- Protect the money first. Holding is often right. Each trade costs about 0.25% in fees, so small moves are not worth trading. Think in days and weeks, not minutes.
- Only trade shares whose market is open right now.
- Spread risk: don't put everything in one company; broad funds (S&P 500, Nasdaq 100, Satrix 40) are steadier than single companies.
- Don't flip-flop on your recent decisions unless something clearly changed. Cut a position that keeps falling well below what was paid; take some profit after a strong rise.
- "size": for a buy, the fraction (0.1 to 1) of the maximum trade amount; for a sell, the fraction (0.1 to 1) of that holding to sell (1 = all).
- The owner may give you instructions or news (in "owner_instructions"). Follow them where sensible, but never break the safety limits.
- "confidence" 0 to 1, honestly. "reason": ONE short sentence in plain everyday English (no jargon like "moving average"), naming the company.
Reply with only JSON: {"action":"hold","symbol":"SPY","size":0.5,"confidence":0.5,"reason":"..."}`;

async function claudeText(apiKey: string, messages: { role: string; content: string }[]) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: Deno.env.get("STOCK_MODEL") || "claude-haiku-5-5", max_tokens: 1200, system: SYSTEM, messages }),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return (j.content || []).map((c: { type?: string; text?: string }) => (c.type === "text" ? c.text || "" : "")).join("");
}
function readDecision(text: string): Record<string, unknown> | null {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (_) { /* loose */ } }
  const pick = (k: string) => {
    const m = text.match(new RegExp(`"${k}"\\s*:\\s*("([^"]*)"?|[0-9.]+)`));
    return m ? (m[2] !== undefined ? m[2] : m[1]) : undefined;
  };
  const action = pick("action");
  return action ? { action, symbol: pick("symbol"), size: pick("size"), confidence: pick("confidence"), reason: pick("reason") || "" } : null;
}
async function askClaude(context: unknown) {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("The ANTHROPIC_API_KEY secret is missing in Supabase.");
  const messages = [{ role: "user", content: JSON.stringify(context) }];
  let text = await claudeText(apiKey, messages);
  let d = readDecision(text);
  if (!d) {
    text = await claudeText(apiKey, [...messages, { role: "assistant", content: text.slice(0, 2000) || "..." },
      { role: "user", content: 'Reply again with ONLY the JSON object. Example: {"action":"hold","symbol":"SPY","size":0.5,"confidence":0.5,"reason":"..."}' }]);
    d = readDecision(text);
  }
  if (!d) throw new Error(`Claude's answer was not understood: "${text.slice(0, 160)}"`);
  const action = String(d.action).toLowerCase();
  return {
    action: ["buy", "sell", "hold"].includes(action) ? action : "hold",
    symbol: String(d.symbol || "").toUpperCase().trim(),
    size: Math.min(1, Math.max(0.1, +String(d.size) || 0.5)),
    confidence: Math.min(1, Math.max(0, +String(d.confidence) || 0)),
    reason: String(d.reason || "").slice(0, 300),
  };
}

function sastDayStart() {
  const now = new Date(Date.now() + 2 * 3600e3);
  now.setUTCHours(0, 0, 0, 0);
  return new Date(now.getTime() - 2 * 3600e3).toISOString();
}

// ---------- one run ----------
async function runOnce(opts: { force?: boolean }) {
  const { data: s } = await db.from("stock_settings").select("*").eq("id", 1).single();
  if (!s) throw new Error("Run stocks.sql in Supabase first.");
  if (!s.enabled && !opts.force) return { skipped: "Bot is switched off." };

  const { data: paper } = await db.from("stock_paper").select("*").eq("id", 1).single();
  const { data: posRows } = await db.from("stock_positions").select("*");
  const positions = (posRows || []) as { symbol: string; shares: number; cost_zar: number; opened_at: string }[];
  const watch: string[] = [...new Set([...(s.watchlist || []), ...positions.map((p) => p.symbol)])].slice(0, 25);

  // dollar-rand rate
  let usdzar = 0;
  try { const fx = await yahoo("ZAR=X", "1d", "5d"); usdzar = +fx.meta.regularMarketPrice || 0; } catch (e) { notes.push(String(e)); }
  if (!usdzar) throw new Error("Couldn't get the dollar-rand exchange rate from Yahoo Finance.");

  const charts: Record<string, Chart> = {};
  for (const sym of watch) {
    try { charts[sym] = await chart(sym, true); } catch (e) { notes.push(e instanceof Error ? e.message : String(e)); }
  }
  const rate = (sym: string) => charts[sym] ? toRand(charts[sym].currency, usdzar) : 0;
  const priceZar = (sym: string) => charts[sym] ? (charts[sym].price || charts[sym].daily.at(-1) || 0) * rate(sym) : 0;

  const cash = +paper!.cash_zar;
  const holdingsValue = positions.reduce((t, p) => t + p.shares * priceZar(p.symbol), 0);
  const value = cash + holdingsValue;
  const openSyms = watch.filter((x) => charts[x]?.open && rate(x) > 0);
  const usOpen = openSyms.some((x) => !x.endsWith(".JO")), jseOpen = openSyms.some((x) => x.endsWith(".JO"));

  const log = async (row: Record<string, unknown>, c = cash, v = value) => {
    await db.from("stock_log").insert({ cash_zar: r2(c), value_zar: r2(v), ...row });
    return { ...row, value_zar: r2(v) };
  };

  if (!openSyms.length) {
    if (opts.force) return { skipped: "The US and JSE markets are both closed right now, so there's nothing to trade. JSE: weekdays 09:00–17:00 SA time. US: weekdays about 16:30–23:00 SA time (15:30–22:00 in the SA winter)." };
    return { skipped: "markets closed" };
  }

  // today so far
  const { data: today } = await db.from("stock_log").select("at,status,action,value_zar").gte("at", sastDayStart()).order("at", { ascending: true });
  const trades = (today || []).filter((t: { status: string; action: string }) => t.status === "done" && t.action !== "hold");
  const first = (today || []).find((t: { value_zar: number | null }) => t.value_zar != null);
  const lossToday = Math.max(0, (first ? +first.value_zar : value) - value);
  const lastTrade = trades.at(-1);
  if (lossToday >= +s.daily_loss_limit_zar)
    return await log({ action: "hold", status: "skipped", reason: `Daily loss limit reached (down R${Math.round(lossToday)} today). Resting until tomorrow.` });

  const { data: recent } = await db.from("stock_log").select("at,symbol,action,status,reason").order("at", { ascending: false }).limit(12);

  const decision = await askClaude({
    now_south_africa: new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 16).replace("T", " "),
    owner_instructions: String(s.owner_notes || "").slice(0, 2000) || "none",
    markets_open: { US: usOpen, JSE: jseOpen },
    usd_to_zar: r2(usdzar),
    watch_list: Object.fromEntries(watch.filter((x) => charts[x] && rate(x) > 0).map((x) => [x, picture(charts[x], rate(x))])),
    cash_rand: r2(cash),
    owned: positions.map((p) => ({
      symbol: p.symbol, name: NAMES[p.symbol] || p.symbol, shares: p.shares,
      paid_rand: r2(p.cost_zar), worth_now_rand: r2(p.shares * priceZar(p.symbol)),
      profit_pct: pct(p.shares * priceZar(p.symbol), p.cost_zar), owned_since: p.opened_at.slice(0, 10),
    })),
    total_value_rand: r2(value),
    limits: {
      max_buy_rand: +s.max_trade_zar, max_different_shares: s.max_holdings, trades_today: trades.length,
      max_trades_per_day: s.max_trades_per_day, loss_today_rand: r2(lossToday), daily_loss_limit_rand: +s.daily_loss_limit_zar,
      min_confidence: +s.min_confidence,
    },
    your_recent_decisions_newest_first: recent || [],
  });

  const sym = decision.symbol;
  const base = { action: decision.action, symbol: sym || null, confidence: decision.confidence, reason: decision.reason, price_zar: sym ? r2(priceZar(sym)) || null : null };
  if (decision.action === "hold") return await log({ ...base, status: "done" });

  const skip = (why: string) => log({ ...base, status: "skipped", reason: `${decision.reason} (Not done: ${why})` });
  if (!sym || !charts[sym]) return await skip("unknown share");
  if (!openSyms.includes(sym)) return await skip("that market is closed right now");
  if (decision.confidence < +s.min_confidence) return await skip(`Claude was only ${Math.round(decision.confidence * 100)}% sure`);
  if (trades.length >= s.max_trades_per_day) return await skip("daily trade limit reached");
  if (lastTrade && Date.now() - Date.parse(lastTrade.at) < s.min_minutes_between * 60e3) return await skip("too soon after the last trade");

  const fee = +(Deno.env.get("STOCK_FEE") || 0.0025);
  const px = priceZar(sym);
  const pos = positions.find((p) => p.symbol === sym);

  if (decision.action === "buy") {
    if (!pos && positions.length >= s.max_holdings) return await skip(`already owns ${positions.length} different shares (the limit)`);
    const spend = Math.floor(Math.min(+s.max_trade_zar * decision.size, cash * 0.995));
    if (spend < 100) return await skip("not enough cash");
    const shares = (spend * (1 - fee)) / px;
    if (pos) await db.from("stock_positions").update({ shares: +pos.shares + shares, cost_zar: +pos.cost_zar + spend }).eq("symbol", sym);
    else await db.from("stock_positions").insert({ symbol: sym, shares, cost_zar: spend });
    await db.from("stock_paper").update({ cash_zar: cash - spend }).eq("id", 1);
    return await log({ ...base, status: "done", shares, amount_zar: spend }, cash - spend, value - spend * fee);
  }

  // sell
  if (!pos) return await skip("it doesn't own that share");
  const sellShares = decision.size >= 0.95 ? +pos.shares : +pos.shares * decision.size;
  const got = sellShares * px * (1 - fee);
  if (got < 50) return await skip("too small to sell");
  const left = +pos.shares - sellShares;
  if (left * px < 50) await db.from("stock_positions").delete().eq("symbol", sym);
  else await db.from("stock_positions").update({ shares: left, cost_zar: +pos.cost_zar * (left / +pos.shares) }).eq("symbol", sym);
  await db.from("stock_paper").update({ cash_zar: cash + got }).eq("id", 1);
  return await log({ ...base, status: "done", shares: sellShares, amount_zar: r2(got) }, cash + got, value - sellShares * px * fee);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* empty */ }

  let isTimer = false;
  const token = req.headers.get("x-bot-token");
  if (token) {
    const { data } = await db.from("trader_secret").select("token").eq("id", 1).single();
    isTimer = !!data && data.token === token;
    if (!isTimer) return reply({ error: "Wrong bot token." }, 401);
  } else {
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
    const { data } = await db.auth.getUser(jwt);
    if (data?.user?.email?.toLowerCase() !== OWNER) return reply({ error: "Only the owner can use this." }, 403);
  }

  try {
    notes.length = 0;
    if (!isTimer && body.action === "reset_paper") {
      const start = Math.max(1000, +(body.start_zar as number) || 20000);
      await db.from("stock_positions").delete().neq("symbol", "");
      await db.from("stock_paper").update({ cash_zar: start, start_zar: start, started_at: new Date().toISOString() }).eq("id", 1);
      await db.from("stock_log").delete().gte("id", 0);
      return reply({ ok: true });
    }
    if (!isTimer && body.action === "prices") {
      // live prices for the page (owned shares)
      const syms = ((body.symbols as string[]) || []).slice(0, 25);
      let usdzar = 0;
      try { usdzar = +(await yahoo("ZAR=X", "1d", "5d")).meta.regularMarketPrice || 0; } catch (_) { /* ignore */ }
      const out: Record<string, { price_zar: number; open: boolean; change_today_pct: number | null }> = {};
      for (const x of syms) {
        try { const c = await chart(x, false); const k = toRand(c.currency, usdzar); out[x] = { price_zar: r2(c.price * k), open: c.open, change_today_pct: pct(c.price, c.prevClose) }; }
        catch (_) { /* skip */ }
      }
      return reply({ ok: true, usdzar: r2(usdzar), prices: out });
    }
    const out = await runOnce({ force: !isTimer && body.action === "run_now" });
    return reply({ ok: true, result: out, notes: notes.slice(0, 6) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try { await db.from("stock_log").insert({ action: "hold", status: "error", reason: msg.slice(0, 300) }); } catch (_) { /* ignore */ }
    return reply({ error: msg }, 500);
  }
});
