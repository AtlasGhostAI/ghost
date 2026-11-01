// Optional Cloudflare Turnstile verification. Enabled only when the
// TURNSTILE_SECRET_KEY secret is set.

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(env, token, remoteIp) {
  if (!env.TURNSTILE_SECRET_KEY) return { ok: true, enforced: false };
  if (typeof token !== 'string' || token.length < 10 || token.length > 2048) return { ok: false, enforced: true };
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET_KEY);
  form.append('response', token);
  if (remoteIp) form.append('remoteip', remoteIp);
  try {
    const res = await fetch(SITEVERIFY, { method: 'POST', body: form, signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    return { ok: data && data.success === true, enforced: true };
  } catch {
    return { ok: false, enforced: true };
  }
}
