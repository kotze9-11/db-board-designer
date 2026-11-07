// DB Board Designer: "read-board" server function for Supabase.
// It checks that the person is logged in, applies a daily limit, sends the
// photo to the Claude API and returns what Claude read from the board.
//
// Secrets to add in Supabase (Edge Functions > Secrets):
//   ANTHROPIC_API_KEY  your Claude API key (required)
//   DAILY_LIMIT        photo reads per person per day (optional, default 20)
//   CLAUDE_MODEL       model id (optional, default claude-sonnet-5-5)
//
// In the function's settings, turn OFF "Verify JWT" (Enforce JWT verification).
// This function checks the person's login itself, below.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const PROMPT = `You are helping a South African electrician document an existing electrical distribution board (DB board) from a photo.
Look carefully at the photo and read every device you can see.

Rules:
- List every circuit breaker (MCB) in order: top row first, left to right, then the next row. Do not list the main switch, earth leakage, surge arrester, timers or contactors as circuits.
- "a" is the breaker's amp rating as printed (for example 10, 15, 20, 30, 40). If you can't read it, use your best guess and add a line to "unsure".
- "name": use the circuit label if one is written on or near the breaker; otherwise use "Top 1", "Top 2" ... for the top row and "Bottom 1" ... for the next row (or "Row 3 1" and so on).
- "noEl": true if that breaker is clearly NOT fed through the earth leakage unit (for example a separate row or busbar fed straight from the main switch). If you can't tell, use false.
- "phases": 3 if the main switch has 3 or 4 poles or you can see three phase colours (red, yellow/white, blue) coming in; otherwise 1.
- "ph": for three-phase boards, the phase each breaker is on if you can tell, otherwise spread them L1, L2, L3 in order. For single phase use "L1".
- "mainA": main switch rating. "el": the earth leakage unit (on, amp rating "a", trip level "ma" in mA, usually 30). "elType": "A" or "AC" if printed, else "AC".
- "spd": true only if you can see a surge arrester.
- "curve": breaker trip curve (B, C or D; curve 3 counts as C). "ka": breaking capacity in kA as printed (often 3, 4.5, 6 or 10).
- "inverter": present true only if you can see an inverter, changeover/bypass switch or clear signs of one.
- "notes": short, plain-English descriptions of visible problems an electrician should fix, for example burn or scorch marks, melted insulation, taped joints, loose or exposed wires, missing covers or blanking plates, overcrowding, wrong-coloured conductors, signs of water. Only what you can actually see.
- "unsure": short notes about anything you could not read or had to guess.

Reply with only this JSON, no other text:
{"name":"Board from photo","phases":1,"mainA":63,"el":{"on":true,"a":63,"ma":30},"elType":"AC","spd":false,"curve":"C","ka":3,
 "circuits":[{"name":"Top 1","a":20,"noEl":false,"ph":"L1"}],
 "inverter":{"present":false,"kw":null},
 "notes":["..."],"unsure":["..."]}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ error: "Use POST.", code: "bad_request" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return reply({ error: "Photo reading isn't set up yet (missing Claude API key).", code: "not_configured" }, 500);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // 1. Who is asking?
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who, error: whoErr } = await admin.auth.getUser(jwt);
  if (whoErr || !who?.user) return reply({ error: "Please sign in again.", code: "not_signed_in" }, 401);
  const userId = who.user.id;

  // 2. Daily limit per person
  const limit = Number(Deno.env.get("DAILY_LIMIT") || "20");
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count } = await admin.from("photo_reads").select("id", { count: "exact", head: true })
    .eq("user_id", userId).gte("created_at", since);
  if ((count ?? 0) >= limit) {
    return reply({ error: `You've reached today's limit of ${limit} photo reads. Try again tomorrow.`, code: "limit" }, 429);
  }

  // 3. Check the photo
  let body: { image?: string; mediaType?: string; extra?: string };
  try { body = await req.json(); } catch { return reply({ error: "Bad request.", code: "bad_request" }, 400); }
  const image = String(body.image || "");
  const mediaType = ["image/jpeg", "image/png", "image/webp"].includes(String(body.mediaType)) ? String(body.mediaType) : "image/jpeg";
  if (!image || image.length > 8_000_000) return reply({ error: "The photo is missing or too large.", code: "image_rejected" }, 400);
  const extra = String(body.extra || "").slice(0, 300).replace(/"/g, "'");

  const { data: logRow } = await admin.from("photo_reads").insert({ user_id: userId }).select("id").single();

  // 4. Ask Claude
  const text = PROMPT + (extra ? `\n\nThe person also says: "${extra}"` : "");
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: Deno.env.get("CLAUDE_MODEL") || "claude-sonnet-5-5",
        max_tokens: 4000,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
          { type: "text", text },
        ] }],
      }),
    });
  } catch {
    return reply({ error: "Couldn't reach Claude. Try again in a moment.", code: "upstream_error" }, 502);
  }
  if (!res.ok) {
    const detail = await res.text();
    console.error("Claude API error", res.status, detail);
    const code = res.status === 429 || res.status === 529 ? "rate_limited" : "upstream_error";
    const msg = res.status === 401 ? "The Claude API key is wrong. Check the ANTHROPIC_API_KEY secret."
      : res.status === 400 && /credit/i.test(detail) ? "The Claude API account is out of credit. Top it up in the Claude Console."
      : "Claude couldn't read the photo right now. Try again in a moment.";
    return reply({ error: msg, code }, 502);
  }
  const out = await res.json();
  const answer = (out.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
  const a = answer.indexOf("{"), b = answer.lastIndexOf("}");
  let reading: unknown = null;
  try { reading = JSON.parse(answer.slice(a, b + 1)); } catch { /* handled below */ }

  if (logRow?.id) {
    await admin.from("photo_reads").update({
      ok: !!reading, tokens_in: out.usage?.input_tokens ?? null, tokens_out: out.usage?.output_tokens ?? null,
    }).eq("id", logRow.id);
  }
  if (!reading || typeof reading !== "object") {
    return reply({ error: "The answer couldn't be turned into a board. Try again, or with a clearer photo.", code: "invalid_json" }, 502);
  }
  return reply({ reading });
});
