# Setting up the DB Board Designer website

The website is in the `app` folder. Once GitHub Pages is on, it lives at
https://kotze9-11.github.io/db-board-designer/app/

## 1. Supabase (logins and saved boards), free
1. Go to supabase.com, sign up, and click **New project**. Pick a name, a strong database password, and the region closest to South Africa.
2. When it's ready, open **SQL Editor > New query**, paste everything from `supabase/setup.sql`, and click **Run**.
3. Open **Authentication > URL Configuration**. Set **Site URL** to `https://kotze9-11.github.io/db-board-designer/app/` and add the same address under **Redirect URLs**.
4. Open **Project Settings > API**. Copy the **Project URL** and the **anon public** key into `app/config.js` (or send them to Claude to do it).

## 2. Claude API (reads the photos), pay as you go
1. Go to console.anthropic.com and sign up.
2. Under **Billing**, add a card and buy a small amount of credit (about $5). Set a monthly spend limit.
3. Under **API Keys**, create a key. Copy it. Keep it secret: never put it on the website or send it in a chat.

## 3. The photo-reading function in Supabase
1. In Supabase, open **Edge Functions > Deploy a new function > Via Editor**.
2. Name it exactly `read-board`.
3. Delete the example code, paste everything from `supabase/functions/read-board/index.ts`, and click **Deploy**.
   Then open the function's **Details / Settings** and turn **off** "Verify JWT" (Enforce JWT verification), and save. The function checks the login itself.
4. Open **Edge Functions > Secrets**, add `ANTHROPIC_API_KEY` with your Claude API key, and save.
   Optional: `DAILY_LIMIT` (photo reads per person per day, default 20).

## 4. Test
Open the website, register, confirm the email, sign in, and try **Read board from photo**.
