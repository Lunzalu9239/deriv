// Cloudflare Pages Function: handles /api/request and /api/verify
// Needs: KV binding "KV", secrets TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });

const okEmail = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length < 200;

export async function onRequestPost({ request, env, params }) {
  const route = Array.isArray(params.route) ? params.route[0] : params.route;
  let b;
  try { b = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }

  if (route === 'request') {
    let email = (b.email || '').toLowerCase().trim();
    const marks = Number(b.marks);
    if (!okEmail(email)) return json({ error: 'Invalid email' }, 400);
    if (!(marks >= 0 && marks <= 100)) return json({ error: 'Invalid marks' }, 400);

    // If signed in with Google, trust Google's email, not the one the browser sent
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

    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
    await env.KV.put('c:' + email, JSON.stringify({ code, tries: 0 }), { expirationTtl: 60 * 60 * 24 * 3 });

    const text =
      `📥 New Lunzalu access request\n\nEmail: ${email}\nMarks: ${marks}\nSign-in: ${via}\n\n` +
      `Code to send them if you confirm: ${code}`;
    const t = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    });
    if (!t.ok) return json({ error: 'Could not send request, try again' }, 502);
    return json({ ok: true });
  }

  if (route === 'verify') {
    const email = (b.email || '').toLowerCase().trim();
    const code = String(b.code || '').trim();
    if (!okEmail(email) || !/^\d{6}$/.test(code)) return json({ error: 'Invalid details' }, 400);

    const raw = await env.KV.get('c:' + email);
    if (!raw) return json({ error: 'No pending request for this email' }, 404);
    const rec = JSON.parse(raw);
    if (rec.tries >= 5) return json({ error: 'Too many attempts. Submit a new request.' }, 429);

    if (rec.code !== code) {
      rec.tries++;
      await env.KV.put('c:' + email, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 });
      return json({ error: 'Wrong code' }, 401);
    }
    await env.KV.delete('c:' + email); // one-time use
    return json({ ok: true });
  }

  return json({ error: 'Not found' }, 404);
}
