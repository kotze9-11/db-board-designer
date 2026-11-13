// Private chat: "chat-push" server function for Supabase.
// Sends a notification ("Bernad: sent you a message") to the other person's devices.
// Messages are encrypted in the browser, so this function never sees what was written.
//
// Setup: Edge Functions > Deploy a new function > name it chat-push > paste this > Deploy.
// In the function's settings, turn OFF "Verify JWT". It checks the login itself, below.
// No secrets to add: the notification keys are created automatically the first time.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

async function vapid() {
  let { data } = await admin.from("chat_vapid").select("public_key,private_key").eq("id", 1).maybeSingle();
  if (!data) {
    const k = webpush.generateVAPIDKeys();
    await admin.from("chat_vapid").upsert({ id: 1, public_key: k.publicKey, private_key: k.privateKey }, { onConflict: "id", ignoreDuplicates: true });
    ({ data } = await admin.from("chat_vapid").select("public_key,private_key").eq("id", 1).maybeSingle());
  }
  if (!data) throw new Error("no keys");
  webpush.setVapidDetails("mailto:kotzeb@yahoo.com", data.public_key, data.private_key);
  return data.public_key as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ error: "Use POST" }, 405);

  // Who is asking? Must be signed in and one of the chat members.
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(token);
  const email = (u?.user?.email || "").toLowerCase();
  if (!email) return reply({ error: "Please sign in again." }, 401);
  const { data: members } = await admin.from("chat_members").select("email,display_name");
  const meRow = (members || []).find((m) => m.email.toLowerCase() === email);
  if (!meRow) return reply({ error: "Not a chat member." }, 403);

  let body: { action?: string; sub?: { endpoint?: string }; endpoint?: string; kind?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }

  // Call relay (TURN) logins from Cloudflare, so calls get through strict networks like offshore Wi-Fi.
  // Needs two secrets: CF_TURN_KEY_ID and CF_TURN_KEY_TOKEN (Cloudflare > Realtime > TURN Server).
  if (body.action === "turn") {
    const id = (Deno.env.get("CF_TURN_KEY_ID") || "").trim(), tok = (Deno.env.get("CF_TURN_KEY_TOKEN") || "").trim();
    if (!id || !tok) return reply({ iceServers: [], note: "No relay set up yet (CF_TURN_KEY_ID / CF_TURN_KEY_TOKEN secrets missing)." });
    let why = "";
    for (const path of ["generate-ice-servers", "generate"]) {
      try {
        const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ttl: 43200 }),
        });
        if (!r.ok) { why = `Cloudflare said ${r.status}: ${(await r.text()).slice(0, 150)}`; continue; }
        const j = await r.json();
        const list = Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers];
        // browsers block port 53, so leave those out
        const clean = list.filter(Boolean).map((s: { urls: string | string[]; username?: string; credential?: string }) => ({
          ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53\b/.test(u)),
        })).filter((s: { urls: string[] }) => s.urls.length);
        if (clean.length) return reply({ iceServers: clean });
      } catch (e) { why = `Couldn't reach Cloudflare: ${e instanceof Error ? e.message : e}`; }
    }
    return reply({ iceServers: [], note: `Cloudflare didn't give relay logins (${why || "no reason given"}). Key ID length ${id.trim().length}, token length ${tok.trim().length}.` });
  }

  try {
    const publicKey = await vapid();
    if (body.action === "key") return reply({ publicKey });

    if (body.action === "subscribe") {
      const ep = body.sub?.endpoint;
      if (!ep || !/^https:\/\//.test(ep)) return reply({ error: "Bad subscription" }, 400);
      await admin.from("chat_push_subs").upsert({ endpoint: ep, email, sub: body.sub });
      return reply({ ok: true });
    }

    if (body.action === "unsubscribe") {
      if (body.endpoint) await admin.from("chat_push_subs").delete().eq("endpoint", body.endpoint).eq("email", email);
      return reply({ ok: true });
    }

    if (body.action === "notify") {
      const call = body.kind === "call";
      const payload = JSON.stringify({
        title: meRow.display_name,
        body: call ? "is calling you" : "sent you a message",
        tag: call ? "chat-call" : "chat",
      });
      const { data: subs } = await admin.from("chat_push_subs").select("endpoint,sub").neq("email", email);
      let sent = 0;
      for (const s of subs || []) {
        try {
          await webpush.sendNotification(s.sub, payload, { TTL: call ? 60 : 3600, urgency: "high" });
          sent++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) await admin.from("chat_push_subs").delete().eq("endpoint", s.endpoint);
        }
      }
      return reply({ sent });
    }
    return reply({ error: "Unknown action" }, 400);
  } catch (e) {
    return reply({ error: "Notification server error", detail: String(e) }, 500);
  }
});
