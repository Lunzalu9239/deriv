// Cloudflare Pages Function: handles /api/request and /api/verify
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

// Makes a 6-digit code that has never been issued to anyone before
async function uniqueCode(env, email) {
  for (let i = 0; i < 20; i++) {
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
    if (!(await env.KV.get('u:' + code))) {
      await env.KV.put('u:' + code, email); // reserved permanently, never reused
      return code;
    }
  }
  return null;
}

async function handle({ request, env, params }) {
  const route = Array.isArray(params.route) ? params.route[0] : params.route;
  let b;
  try { b = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }

  if (route === 'request') {
    let email = (b.email || '').toLowerCase().trim();
    const marks = String(b.marks ?? '').trim();
    if (!okEmail(email)) return json({ error: 'Invalid email' }, 400);
    if (marks.length < 1 || marks.length > 30) return json({ error: 'Marks must be 1 to 30 characters' }, 400);

    if (!env.KV) return json({ error: 'KV binding missing: add a KV namespace named KV, then redeploy' }, 500);
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return json({ error: 'Telegram secrets missing: add them, then redeploy' }, 500);

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

    const code = await uniqueCode(env, email);
    if (!code) return json({ error: 'Could not create a code, try again' }, 500);
    await env.KV.put('c:' + email, JSON.stringify({ code, marks, tries: 0 }), { expirationTtl: 60 * 60 * 24 * 3 });

    const t = await tg(env,
      `New Lunzalu access request\n\nEmail: ${email}\nMarks: ${marks}\nSign-in: ${via}\n\n` +
      `Code to send them if you confirm: ${code}`);
    if (!t.ok) {
      const d = await t.text();
      return json({ error: 'Telegram refused: ' + d.slice(0, 120) }, 502);
    }
    return json({ ok: true });
  }

  if (route === 'verify') {
    const email = (b.email || '').toLowerCase().trim();
    const code = String(b.code || '').trim();
    if (!okEmail(email) || !/^\d{6}$/.test(code)) return json({ error: 'Invalid details' }, 400);
    if (!env.KV) return json({ error: 'KV binding missing' }, 500);

    const raw = await env.KV.get('c:' + email);
    if (!raw) return json({ error: 'No pending request for this email' }, 404);
    const rec = JSON.parse(raw);
    if (rec.tries >= 5) return json({ error: 'Too many attempts. Submit a new request.' }, 429);

    if (rec.code !== code) {
      rec.tries++;
      await env.KV.put('c:' + email, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 });
      return json({ error: 'Wrong code' }, 401);
    }
    await env.KV.delete('c:' + email); // code can only be used once

    // Tell the owner which email used which code (don't block login if this fails)
    try {
      await tg(env, `Lunzalu login\n\nEmail: ${email}\nCode entered: ${code}\nMarks: ${rec.marks ?? '-'}`);
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
