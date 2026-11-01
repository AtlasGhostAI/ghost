// Global daily ceiling on Helius calls, enforced by one Durable Object
// instance. Durable Objects process requests for a single instance one at a
// time, so this counter is strict (unlike the rate-limit binding).

export class DailyQuota {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    let limit = 0, cost = 1;
    try { const b = await request.json(); limit = Number(b.limit); cost = b.cost === undefined ? 1 : Number(b.cost); } catch { /* fall through */ }
    if (!Number.isSafeInteger(cost) || cost < 1 || cost > 20) cost = 1;
    if (!Number.isSafeInteger(limit) || limit < 0) return Response.json({ ok: false, error: 'bad_limit' }, { status: 400 });
    const today = new Date().toISOString().slice(0, 10);
    const stored = (await this.state.storage.get('quota')) || { day: today, count: 0 };
    const cur = stored.day === today ? stored : { day: today, count: 0 };
    if (cur.count + cost > limit) return Response.json({ ok: false, day: cur.day, count: cur.count, limit });
    cur.count += cost;
    await this.state.storage.put('quota', cur);
    return Response.json({ ok: true, day: cur.day, count: cur.count, limit });
  }
}

/** Returns {ok:true} if `cost` provider calls may proceed. Without the binding, returns {ok:true, enforced:false}. */
export async function consumeDailyQuota(env, cost = 1) {
  if (!env.GLOBAL_QUOTA) return { ok: true, enforced: false };
  const limit = Number(env.DAILY_PROVIDER_CALL_LIMIT || 500);
  try {
    const stub = env.GLOBAL_QUOTA.get(env.GLOBAL_QUOTA.idFromName('global'));
    const res = await stub.fetch('https://quota.internal/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit, cost }),
    });
    const data = await res.json();
    return { ok: data.ok === true, enforced: true };
  } catch {
    return { ok: false, enforced: true }; // fail closed
  }
}
