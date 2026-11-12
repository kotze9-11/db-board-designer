// Crypto trading bot: "trade-bot" server function for Supabase.
// Every 15 minutes the timer (set up by trader.sql) wakes it. It:
//   1. reads Bitcoin prices from VALR (public, no account needed),
//   2. asks Claude whether to buy, sell or hold,
//   3. checks your safety limits,
//   4. trades with pretend money (practice mode) or on your VALR account (live mode),
//   5. writes everything to the trader_log table for the phone page.
//
// Secrets (Edge Functions > Secrets):
//   ANTHROPIC_API_KEY   your Claude API key (already there from the DB board app)
//   VALR_API_KEY        only for live mode: VALR key with TRADE permission only (never withdraw)
//   VALR_API_SECRET     only for live mode
//   TRADER_MODEL        optional, default claude-haiku-5-5
//   TRADER_FEE          optional practice-mode fee per trade, default 0.001 (0.1%)
//
// In the function's settings, turn OFF "Verify JWT". It checks the caller itself.
import { createClient } from "jsr:@supabase/supabase-js@2";

const OWNER = "kotzeb@yahoo.com";
const VALR = "https://api.valr.com";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bot-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// ---------- market data ----------
type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
async function getJson(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`VALR ${r.status} on ${url.replace(VALR, "")}`);
  return r.json();
}
async function candles(pair: string, seconds: number, count: number): Promise<Candle[]> {
  const start = new Date(Date.now() - seconds * 1000 * (count + 2)).toISOString();
  const rows = await getJson(`${VALR}/v1/public/${pair}/buckets?periodSeconds=${seconds}&startTime=${encodeURIComponent(start)}`);
  return (rows as Record<string, unknown>[])
    .map((b) => ({
      t: Date.parse(String(b.startTime)), o: +String(b.open), h: +String(b.high),
      l: +String(b.low), c: +String(b.close), v: +String(b.volume ?? 0),
    }))
    .filter((b) => isFinite(b.c) && b.c > 0)
    .sort((a, b) => a.t - b.t);
}
const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1);
function rsi(closes: number[], n = 14) {
  if (closes.length <= n) return null;
  let g = 0, l = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
const pct = (a: number, b: number) => (b ? ((a - b) / b) * 100 : 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

async function marketPicture(pair: string) {
  const sum = await getJson(`${VALR}/v1/public/${pair}/marketsummary`);
  const price = +sum.lastTradedPrice;
  let m15: Candle[] = [], h1: Candle[] = [];
  try { m15 = await candles(pair, 900, 96); } catch (_) { /* fall back to summary only */ }
  try { h1 = await candles(pair, 3600, 168); } catch (_) { /* fall back */ }
  const c15 = m15.map((c) => c.c), c1h = h1.map((c) => c.c);
  const ago = (arr: Candle[], ms: number) => {
    const t = Date.now() - ms; const x = arr.find((c) => c.t >= t); return x ? x.o : 0;
  };
  return {
    price,
    bid: +sum.bidPrice, ask: +sum.askPrice,
    high24h: +sum.highPrice, low24h: +sum.lowPrice,
    change_1h_pct: m15.length ? r2(pct(price, ago(m15, 3600e3))) : null,
    change_24h_pct: r2(+sum.changeFromPrevious || pct(price, +sum.previousClosePrice)),
    change_7d_pct: h1.length ? r2(pct(price, h1[0].o)) : null,
    avg_15m_x20: c15.length >= 20 ? Math.round(avg(c15.slice(-20))) : null,
    avg_15m_x50: c15.length >= 50 ? Math.round(avg(c15.slice(-50))) : null,
    avg_1h_x24: c1h.length >= 24 ? Math.round(avg(c1h.slice(-24))) : null,
    avg_1h_x168: c1h.length >= 100 ? Math.round(avg(c1h)) : null,
    rsi_15m: c15.length ? (rsi(c15) === null ? null : Math.round(rsi(c15)!)) : null,
    rsi_1h: c1h.length ? (rsi(c1h) === null ? null : Math.round(rsi(c1h)!)) : null,
    last_8_hours_closes: c1h.slice(-8).map(Math.round),
  };
}

// ---------- VALR account (live mode) ----------
async function hmacHex(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function valrPrivate(method: string, path: string, body?: unknown) {
  const key = Deno.env.get("VALR_API_KEY"), secret = Deno.env.get("VALR_API_SECRET");
  if (!key || !secret) throw new Error("Live mode needs the VALR_API_KEY and VALR_API_SECRET secrets in Supabase.");
  const ts = Date.now().toString(), text = body ? JSON.stringify(body) : "";
  const sig = await hmacHex(secret, ts + method.toUpperCase() + path + text);
  const r = await fetch(VALR + path, {
    method,
    headers: { "X-VALR-API-KEY": key, "X-VALR-SIGNATURE": sig, "X-VALR-TIMESTAMP": ts, "Content-Type": "application/json" },
    body: text || undefined,
  });
  const out = await r.text();
  if (!r.ok) throw new Error(`VALR said ${r.status}: ${out.slice(0, 200)}`);
  return out ? JSON.parse(out) : {};
}
async function liveBalances(pair: string) {
  const base = pair.replace(/ZAR$/, "");
  const rows = await valrPrivate("GET", "/v1/account/balances") as { currency: string; available: string }[];
  const get = (c: string) => +(rows.find((r) => r.currency === c)?.available ?? 0);
  return { zar: get("ZAR"), btc: get(base) };
}

// ---------- Claude ----------
const SYSTEM = `You are a careful, disciplined crypto trader managing a small amount of money for a South African owner who accepts he may lose it.
Each time you are called you see the latest market picture for one coin priced in rand, the current wallet, the safety limits and your own recent decisions.
Decide one of: "buy", "sell" or "hold".
Principles:
- Protect the money first. Holding is often the right answer. Fees are about 0.1% per trade, so tiny moves are not worth trading.
- Do not flip-flop: respect your own recent decisions unless the market has clearly changed.
- Prefer buying after a pull-back in an up-trend and selling into strength or when the trend clearly breaks down. Avoid chasing big spikes.
- "size" is the fraction (0.1 to 1) of the maximum trade size to use. Use smaller sizes when less sure.
- "confidence" (0 to 1) is how sure you are. Be honest; low confidence trades will be skipped.
- "reason" is ONE short sentence in plain everyday English (no jargon like RSI or SMA) that a non-trader understands.
Reply with only JSON: {"action":"hold","size":0.5,"confidence":0.5,"reason":"..."}`;

async function askClaude(context: unknown) {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("The ANTHROPIC_API_KEY secret is missing in Supabase.");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: Deno.env.get("TRADER_MODEL") || "claude-haiku-5-5",
      max_tokens: 300,
      system: SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(context) }],
    }),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const text = (j.content || []).map((c: { text?: string }) => c.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Claude's answer was not understood.");
  const d = JSON.parse(m[0]);
  const action = ["buy", "sell", "hold"].includes(d.action) ? d.action : "hold";
  return {
    action,
    size: Math.min(1, Math.max(0.1, +d.size || 0.5)),
    confidence: Math.min(1, Math.max(0, +d.confidence || 0)),
    reason: String(d.reason || "").slice(0, 300),
  };
}

// ---------- helpers ----------
function sastDayStart() {
  const now = new Date(Date.now() + 2 * 3600e3); // South African time
  now.setUTCHours(0, 0, 0, 0);
  return new Date(now.getTime() - 2 * 3600e3).toISOString();
}

// ---------- one run ----------
async function runOnce(opts: { force?: boolean }) {
  const { data: s } = await db.from("trader_settings").select("*").eq("id", 1).single();
  if (!s) throw new Error("Run trader.sql in Supabase first.");
  if (!s.enabled && !opts.force) return { skipped: "Bot is switched off." };

  const mkt = await marketPicture(s.pair);
  const price = mkt.price;

  // wallet
  let wallet: { zar: number; btc: number };
  if (s.mode === "live") wallet = await liveBalances(s.pair);
  else {
    const { data: p } = await db.from("trader_paper").select("*").eq("id", 1).single();
    wallet = { zar: +p!.zar, btc: +p!.btc };
  }
  const value = wallet.zar + wallet.btc * price;

  // today so far
  const dayStart = sastDayStart();
  const { data: today } = await db.from("trader_log").select("at,status,action,value_zar,mode")
    .gte("at", dayStart).eq("mode", s.mode).order("at", { ascending: true });
  const tradesToday = (today || []).filter((t) => t.status === "done" && t.action !== "hold");
  const openValue = today && today.length ? +today[0].value_zar : value;
  const lossToday = Math.max(0, openValue - value);
  const lastTrade = tradesToday.length ? tradesToday[tradesToday.length - 1] : null;

  const { data: recent } = await db.from("trader_log").select("at,action,status,confidence,reason,price")
    .eq("mode", s.mode).order("at", { ascending: false }).limit(12);

  const limits = {
    max_trade_zar: +s.max_trade_zar, max_trades_per_day: s.max_trades_per_day,
    trades_done_today: tradesToday.length, loss_today_zar: r2(lossToday),
    daily_loss_limit_zar: +s.daily_loss_limit_zar, min_confidence: +s.min_confidence,
  };

  const log = async (row: Record<string, unknown>, w = wallet) => {
    const v = w.zar + w.btc * price;
    await db.from("trader_log").insert({
      mode: s.mode, price, zar: w.zar, btc: w.btc, value_zar: r2(v), ...row,
    });
    return { ...row, price, value_zar: r2(v) };
  };

  // hard stops before even asking Claude
  if (lossToday >= +s.daily_loss_limit_zar)
    return await log({ action: "hold", status: "skipped", reason: `Daily loss limit reached (lost R${Math.round(lossToday)} today). Resting until tomorrow.` });

  const decision = await askClaude({
    now_south_africa: new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 16).replace("T", " "),
    pair: s.pair, market: mkt,
    wallet: { rand: r2(wallet.zar), coin: wallet.btc, coin_value_rand: r2(wallet.btc * price), total_rand: r2(value) },
    limits,
    your_recent_decisions_newest_first: (recent || []).map((r) => ({
      at: r.at, action: r.action, status: r.status, price: r.price, reason: r.reason,
    })),
  });

  const base = { action: decision.action, confidence: decision.confidence, reason: decision.reason };
  if (decision.action === "hold") return await log({ ...base, status: "done" });

  // safety checks
  const skip = (why: string) => log({ ...base, status: "skipped", reason: `${decision.reason} (Not done: ${why})` });
  if (decision.confidence < +s.min_confidence) return await skip(`Claude was only ${Math.round(decision.confidence * 100)}% sure`);
  if (tradesToday.length >= s.max_trades_per_day) return await skip("daily trade limit reached");
  if (lastTrade && Date.now() - Date.parse(lastTrade.at) < s.min_minutes_between * 60e3)
    return await skip("too soon after the last trade");

  const want = +s.max_trade_zar * decision.size;
  const fee = +(Deno.env.get("TRADER_FEE") || 0.001);

  if (decision.action === "buy") {
    const spend = Math.floor(Math.min(want, wallet.zar * 0.995));
    if (spend < 50) return await skip("not enough rand to buy");
    if (s.mode === "live") {
      await valrPrivate("POST", "/v1/orders/market", { pair: s.pair, side: "BUY", quoteAmount: String(spend) });
      await new Promise((r) => setTimeout(r, 2500));
      const w = await liveBalances(s.pair);
      return await log({ ...base, status: "done", amount_zar: spend, amount_btc: r2((w.btc - wallet.btc) * 1e8) / 1e8 }, w);
    }
    const coins = (spend * (1 - fee)) / mkt.ask;
    const w = { zar: wallet.zar - spend, btc: wallet.btc + coins };
    await db.from("trader_paper").update({ zar: w.zar, btc: w.btc }).eq("id", 1);
    return await log({ ...base, status: "done", amount_zar: spend, amount_btc: coins }, w);
  }

  // sell
  const coins = Math.min(want / price, wallet.btc);
  const coinsRounded = Math.floor(coins * 1e8) / 1e8;
  if (coinsRounded * price < 50) return await skip("no coins to sell");
  if (s.mode === "live") {
    await valrPrivate("POST", "/v1/orders/market", { pair: s.pair, side: "SELL", baseAmount: coinsRounded.toFixed(8) });
    await new Promise((r) => setTimeout(r, 2500));
    const w = await liveBalances(s.pair);
    return await log({ ...base, status: "done", amount_btc: coinsRounded, amount_zar: r2(w.zar - wallet.zar) }, w);
  }
  const got = coinsRounded * mkt.bid * (1 - fee);
  const w = { zar: wallet.zar + got, btc: wallet.btc - coinsRounded };
  await db.from("trader_paper").update({ zar: w.zar, btc: w.btc }).eq("id", 1);
  return await log({ ...base, status: "done", amount_btc: coinsRounded, amount_zar: r2(got) }, w);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* empty */ }

  // who is calling: the timer (secret token) or the owner (logged in)
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
    if (!isTimer && body.action === "reset_paper") {
      const start = Math.max(100, +(body.start_zar as number) || 5000);
      await db.from("trader_paper").update({ zar: start, btc: 0, start_zar: start, started_at: new Date().toISOString() }).eq("id", 1);
      await db.from("trader_log").delete().eq("mode", "paper");
      return reply({ ok: true });
    }
    if (!isTimer && body.action === "live_balance") {
      const { data: s } = await db.from("trader_settings").select("pair").eq("id", 1).single();
      return reply(await liveBalances(s!.pair));
    }
    const out = await runOnce({ force: !isTimer && body.action === "run_now" });
    return reply({ ok: true, result: out });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      const { data: s } = await db.from("trader_settings").select("mode").eq("id", 1).single();
      await db.from("trader_log").insert({ mode: s?.mode || "paper", action: "hold", status: "error", reason: msg.slice(0, 300) });
    } catch (_) { /* ignore */ }
    return reply({ error: msg }, 500);
  }
});
