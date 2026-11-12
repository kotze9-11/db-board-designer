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
const notes: string[] = [];
function parseBuckets(raw: unknown): Candle[] {
  const arr = Array.isArray(raw) ? raw : (raw as Record<string, unknown>)?.buckets ?? (raw as Record<string, unknown>)?.data ?? [];
  return (arr as Record<string, unknown>[])
    .map((b) => {
      const st = b.startTime ?? b.time ?? b.timestamp;
      const t = typeof st === "number" ? (st < 1e12 ? st * 1000 : st) : Date.parse(String(st));
      return { t, o: +String(b.open), h: +String(b.high), l: +String(b.low), c: +String(b.close), v: +String(b.volume ?? 0) };
    })
    .filter((b) => isFinite(b.c) && b.c > 0 && isFinite(b.t))
    .sort((a, b) => a.t - b.t);
}
// VALR price history. Tries a few address formats and keeps the first that works.
async function candles(pair: string, seconds: number, count: number): Promise<Candle[]> {
  const startMs = Date.now() - seconds * 1000 * (count + 2);
  const tries = [
    `periodSeconds=${seconds}&startTime=${Math.floor(startMs / 1000)}`,
    `periodSeconds=${seconds}`,
    `periodSeconds=${seconds}&startTime=${encodeURIComponent(new Date(startMs).toISOString())}`,
  ];
  for (const q of tries) {
    try {
      const rows = parseBuckets(await getJson(`${VALR}/v1/public/${pair}/buckets?${q}`));
      if (rows.length >= 3) return rows.filter((r) => r.t >= startMs - seconds * 1000);
      notes.push(`buckets ${q}: only ${rows.length} rows`);
    } catch (e) {
      notes.push(`buckets ${q}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return [];
}
// Backup source: CoinGecko's free Bitcoin price history in rand (no account needed).
async function coingecko(pair: string, days: number, seconds: number): Promise<Candle[]> {
  const ids: Record<string, string> = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "ripple" };
  const id = ids[pair.replace(/ZAR$/, "")];
  if (!id) return [];
  try {
    const j = await getJson(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=zar&days=${days}`);
    const pts = ((j.prices || []) as [number, number][]).map(([t, price]) => ({ at: new Date(t).toISOString(), price }));
    return fromOwnChecks(pts, seconds);
  } catch (e) {
    notes.push(`coingecko: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}
// Fallback: build price history from the bot's own checks (one price every 15 minutes).
function fromOwnChecks(points: { at: string; price: number }[], seconds: number): Candle[] {
  const groups = new Map<number, number[]>();
  for (const p of points) {
    if (!p.price) continue;
    const k = Math.floor(Date.parse(p.at) / (seconds * 1000)) * seconds * 1000;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(+p.price);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0])
    .map(([t, v]) => ({ t, o: v[0], h: Math.max(...v), l: Math.min(...v), c: v[v.length - 1], v: 0 }));
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

async function marketPicture(pair: string, own: { at: string; price: number }[]) {
  const sum = await getJson(`${VALR}/v1/public/${pair}/marketsummary`);
  const price = +sum.lastTradedPrice;
  let m15: Candle[] = [], h1: Candle[] = [];
  m15 = await candles(pair, 900, 96);
  h1 = await candles(pair, 3600, 168);
  let source = "VALR price history";
  if (!m15.length || !h1.length) {
    source = "CoinGecko price history (VALR history was not available)";
    if (!m15.length) m15 = await coingecko(pair, 1, 900);
    if (!h1.length) h1 = await coingecko(pair, 7, 3600);
  }
  if (!m15.length || !h1.length) {
    source = "the bot's own price checks (no outside history was available)";
    if (!m15.length) m15 = fromOwnChecks(own, 900);
    if (!h1.length) h1 = fromOwnChecks(own, 3600);
  }
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
    history_source: source,
    history_hours_available: h1.length ? Math.round((Date.now() - h1[0].t) / 3600e3) : 0,
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
const COINS = ["BTCZAR", "ETHZAR", "SOLZAR", "XRPZAR"];
const sym = (pair: string) => pair.replace(/ZAR$/, "");
async function liveBalances(pairs: string[]) {
  const rows = await valrPrivate("GET", "/v1/account/balances") as { currency: string; available: string }[];
  const get = (c: string) => +(rows.find((r) => r.currency === c)?.available ?? 0);
  const coins: Record<string, number> = {};
  for (const p of pairs) coins[p] = get(sym(p));
  return { zar: get("ZAR"), coins };
}

// ---------- Claude ----------
const SYSTEM = `You are a careful, disciplined crypto trader managing a small amount of money for a South African owner who accepts he may lose it.
Each time you are called you see the latest market picture for one or more coins priced in rand, the current wallet, the safety limits and your own recent decisions.
Decide one of: "buy", "sell" or "hold".
Principles:
- Protect the money first. Holding is often the right answer. Fees are about 0.1% per trade, so tiny moves are not worth trading.
- Do not flip-flop: respect your own recent decisions unless the market has clearly changed.
- Prefer buying after a pull-back in an up-trend and selling into strength or when the trend clearly breaks down. Avoid chasing big spikes.
- If several coins are offered, you may buy only ONE of them; pick the one with the best and safest set-up and name it in "coin" (e.g. "ETH"). Smaller coins (SOL, XRP) swing more: only pick them when the set-up is clearly better, and use a smaller size.
- If only one coin is offered, you already hold it (or the owner chose it): manage that coin only.
- "size" is the fraction (0.1 to 1) of the maximum trade size to use. Use smaller sizes when less sure.
- "confidence" (0 to 1) is how sure you are. Be honest; low confidence trades will be skipped.
- "reason" is ONE short sentence in plain everyday English (no jargon like RSI or SMA) that a non-trader understands. Mention the coin by name.
Reply with only JSON: {"action":"hold","coin":"BTC","size":0.5,"confidence":0.5,"reason":"..."}`;

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
    coin: String(d.coin || "").toUpperCase().replace(/ZAR$/, ""),
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
  const auto = s.pair === "AUTO";
  const live = s.mode === "live";
  const watch: string[] = auto ? COINS : [String(s.pair)];

  // wallet: rand plus coins
  let zar = 0;
  let coins: Record<string, number> = {};
  if (live) ({ zar, coins } = await liveBalances(watch));
  else {
    const { data: p } = await db.from("trader_paper").select("*").eq("id", 1).single();
    zar = +p!.zar;
    const pc = p!.coin || (auto ? null : s.pair);
    for (const w of watch) coins[w] = 0;
    if (pc && (auto || pc === s.pair)) coins[pc] = +p!.btc;
  }

  // market pictures for every coin we watch (and any coin still held)
  const { data: own } = await db.from("trader_log").select("at,price,pair")
    .gte("at", new Date(Date.now() - 7 * 24 * 3600e3).toISOString()).not("price", "is", null)
    .order("at", { ascending: true }).limit(2000);
  const pics: Record<string, Awaited<ReturnType<typeof marketPicture>>> = {};
  for (const pr of Object.keys(coins)) {
    const mine = (own || []).filter((o: { pair?: string }) => (o.pair || "BTCZAR") === pr) as { at: string; price: number }[];
    pics[pr] = await marketPicture(pr, mine);
  }
  const priceOf = (pr: string) => pics[pr]?.price || 0;
  const value = zar + Object.keys(coins).reduce((t, pr) => t + coins[pr] * priceOf(pr), 0);

  // which coin is in play
  const held = Object.keys(coins).filter((pr) => coins[pr] * priceOf(pr) >= 50)
    .sort((a, b) => coins[b] * priceOf(b) - coins[a] * priceOf(a));
  const offered: string[] = auto ? (held.length ? [held[0]] : COINS) : [String(s.pair)];

  // today so far
  const dayStart = sastDayStart();
  const { data: today } = await db.from("trader_log").select("at,status,action,value_zar,mode")
    .gte("at", dayStart).eq("mode", s.mode).order("at", { ascending: true });
  const tradesToday = (today || []).filter((t: { status: string; action: string }) => t.status === "done" && t.action !== "hold");
  const firstToday = (today || []).find((t: { value_zar: number | null }) => t.value_zar != null);
  const openValue = firstToday ? +firstToday.value_zar : value;
  const lossToday = Math.max(0, openValue - value);
  const lastTrade = tradesToday.length ? tradesToday[tradesToday.length - 1] : null;

  const { data: recent } = await db.from("trader_log").select("at,pair,action,status,reason,price")
    .eq("mode", s.mode).order("at", { ascending: false }).limit(12);

  const limits = {
    max_trade_zar: +s.max_trade_zar, max_trades_per_day: s.max_trades_per_day,
    trades_done_today: tradesToday.length, loss_today_zar: r2(lossToday),
    daily_loss_limit_zar: +s.daily_loss_limit_zar, min_confidence: +s.min_confidence,
  };

  // write one line to the log
  let logPair = offered[0];
  const log = async (row: Record<string, unknown>, z = zar, c = coins) => {
    const v = z + Object.keys(c).reduce((t, pr) => t + c[pr] * priceOf(pr), 0);
    await db.from("trader_log").insert({
      mode: s.mode, pair: logPair, price: priceOf(logPair), zar: z, btc: c[logPair] || 0, value_zar: r2(v), ...row,
    });
    return { ...row, pair: logPair, price: priceOf(logPair), value_zar: r2(v) };
  };

  if (lossToday >= +s.daily_loss_limit_zar)
    return await log({ action: "hold", status: "skipped", reason: `Daily loss limit reached (lost R${Math.round(lossToday)} today). Resting until tomorrow.` });

  const decision = await askClaude({
    now_south_africa: new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 16).replace("T", " "),
    coins_offered: offered.map(sym),
    markets: Object.fromEntries(offered.map((pr) => [sym(pr), pics[pr]])),
    wallet: {
      rand: r2(zar),
      holding: Object.fromEntries(Object.keys(coins).filter((pr) => coins[pr] > 0)
        .map((pr) => [sym(pr), { amount: coins[pr], value_rand: r2(coins[pr] * priceOf(pr)) }])),
      total_rand: r2(value),
    },
    limits,
    your_recent_decisions_newest_first: (recent || []).map((r: Record<string, unknown>) => ({
      at: r.at, coin: sym(String(r.pair || "BTCZAR")), action: r.action, status: r.status, price: r.price, reason: r.reason,
    })),
  });

  // which coin did Claude mean?
  const named = decision.coin && COINS.includes(decision.coin + "ZAR") ? decision.coin + "ZAR" : null;
  const chosen = named ? (offered.includes(named) ? named : null) : (offered.length === 1 ? offered[0] : null);
  if (chosen) logPair = chosen;
  const base = { action: decision.action, confidence: decision.confidence, reason: decision.reason };
  if (decision.action === "hold") return await log({ ...base, status: "done" });

  const skip = (why: string) => log({ ...base, status: "skipped", reason: `${decision.reason} (Not done: ${why})` });
  if (!chosen) return await skip(named ? `${sym(named)} isn't allowed right now; it can only trade ${offered.map(sym).join(", ")}` : "it didn't say which coin");
  if (decision.confidence < +s.min_confidence) return await skip(`Claude was only ${Math.round(decision.confidence * 100)}% sure`);
  if (tradesToday.length >= s.max_trades_per_day) return await skip("daily trade limit reached");
  if (lastTrade && Date.now() - Date.parse(lastTrade.at) < s.min_minutes_between * 60e3)
    return await skip("too soon after the last trade");

  const pic = pics[chosen];
  const want = +s.max_trade_zar * decision.size;
  const fee = +(Deno.env.get("TRADER_FEE") || 0.001);
  const wait = () => new Promise((r) => setTimeout(r, 2500));

  if (decision.action === "buy") {
    const spend = Math.floor(Math.min(want, zar * 0.995));
    if (spend < 50) return await skip("not enough rand to buy");
    if (live) {
      await valrPrivate("POST", "/v1/orders/market", { pair: chosen, side: "BUY", quoteAmount: String(spend) });
      await wait();
      const w = await liveBalances(watch);
      return await log({ ...base, status: "done", amount_zar: spend, amount_btc: Math.round((w.coins[chosen] - coins[chosen]) * 1e8) / 1e8 }, w.zar, w.coins);
    }
    // practice: small leftovers of another coin are cashed in first (one coin at a time)
    let z = zar;
    const c: Record<string, number> = { ...coins };
    for (const pr of Object.keys(c)) if (pr !== chosen && c[pr] > 0) { z += c[pr] * priceOf(pr) * (1 - fee); c[pr] = 0; }
    const got = (spend * (1 - fee)) / pic.ask;
    c[chosen] = (c[chosen] || 0) + got;
    z -= spend;
    await db.from("trader_paper").update({ zar: z, btc: c[chosen], coin: chosen }).eq("id", 1);
    return await log({ ...base, status: "done", amount_zar: spend, amount_btc: got }, z, c);
  }

  // sell
  const have = coins[chosen] || 0;
  const amount = Math.floor(Math.min(want / pic.price, have) * 1e8) / 1e8;
  if (amount * pic.price < 50) return await skip("no coins to sell");
  if (live) {
    await valrPrivate("POST", "/v1/orders/market", { pair: chosen, side: "SELL", baseAmount: amount.toFixed(8) });
    await wait();
    const w = await liveBalances(watch);
    return await log({ ...base, status: "done", amount_btc: amount, amount_zar: r2(w.zar - zar) }, w.zar, w.coins);
  }
  const got = amount * pic.bid * (1 - fee);
  const c: Record<string, number> = { ...coins, [chosen]: have - amount };
  await db.from("trader_paper").update({ zar: zar + got, btc: c[chosen], coin: chosen }).eq("id", 1);
  return await log({ ...base, status: "done", amount_btc: amount, amount_zar: r2(got) }, zar + got, c);
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
      await db.from("trader_paper").update({ zar: start, btc: 0, coin: null, start_zar: start, started_at: new Date().toISOString() }).eq("id", 1);
      await db.from("trader_log").delete().eq("mode", "paper");
      return reply({ ok: true });
    }
    if (!isTimer && body.action === "live_balance") {
      const { data: s } = await db.from("trader_settings").select("pair").eq("id", 1).single();
      return reply(await liveBalances(s!.pair === "AUTO" ? COINS : [s!.pair]));
    }
    notes.length = 0;
    const out = await runOnce({ force: !isTimer && body.action === "run_now" });
    return reply({ ok: true, result: out, history_notes: notes.slice(0, 6) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      const { data: s } = await db.from("trader_settings").select("mode").eq("id", 1).single();
      await db.from("trader_log").insert({ mode: s?.mode || "paper", action: "hold", status: "error", reason: msg.slice(0, 300) });
    } catch (_) { /* ignore */ }
    return reply({ error: msg }, 500);
  }
});
