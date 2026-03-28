// Echo Waitlist v1.0.0 — Viral waitlist & launch page tool on Cloudflare Workers

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  EMAIL_SENDER: Fetcher;
  ECHO_API_KEY: string;
  ENVIRONMENT: string;
}

interface RLState { c: number; t: number; }

function uid(): string { return crypto.randomUUID().replace(/-/g, '').slice(0, 16); }
function refCode(): string { return Math.random().toString(36).slice(2, 8).toUpperCase(); }
function sanitize(s: string, max = 500): string { return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, max); }
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': '*' , 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'X-XSS-Protection': '1; mode=block', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } });
}
function err(msg: string, status = 400): Response { return json({ error: msg }

function slog(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) {
  const entry = { ts: new Date().toISOString(), level, worker: 'echo-waitlist', version: '1.0.0', msg, ...data };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}
, status); }

function authOk(req: Request, env: Env): boolean {
  return (req.headers.get('X-Echo-API-Key') || new URL(req.url).searchParams.get('key')) === env.ECHO_API_KEY;
}

async function rateLimit(kv: KVNamespace, key: string, max: number, windowMs: number): Promise<boolean> {
  const raw = await kv.get(`rl:${key}`);
  const now = Date.now();
  let state: RLState = raw ? JSON.parse(raw) : { c: 0, t: now };
  state.c = Math.max(0, state.c - ((now - state.t) / windowMs) * max);
  state.t = now;
  if (state.c >= max) return false;
  state.c += 1;
  await kv.put(`rl:${key}`, JSON.stringify(state), { expirationTtl: Math.ceil(windowMs / 1000) * 2 });
  return true;
}

async function hashIP(ip: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + 'echo-wl-salt'));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': '*' } });

    try {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;

    if (p === '/health' || p === '/') return json({ status: 'healthy', service: 'echo-waitlist', version: '1.0.0', timestamp: new Date().toISOString() });

    // ── Public: Join waitlist ──
    if (m === 'POST' && p === '/join') {
      const ip = req.headers.get('CF-Connecting-IP') || '0.0.0.0';
      if (!await rateLimit(env.CACHE, `join:${await hashIP(ip)}`, 5, 3600000)) return err('Rate limited', 429);
      const body = await req.json<{ campaign_id: string; email: string; name?: string; ref?: string; custom_data?: Record<string, string> }>().catch(() => null);
      if (!body?.campaign_id || !body?.email) return err('campaign_id and email required');
      const email = sanitize(body.email.toLowerCase().trim(), 320);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err('Invalid email');

      const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id=? AND status=?').bind(body.campaign_id, 'active').first<any>();
      if (!campaign) return err('Campaign not found or closed', 404);
      if (campaign.max_signups && campaign.total_signups >= campaign.max_signups) return err('Waitlist is full');

      // Check existing
      const existing = await env.DB.prepare('SELECT id, position, referral_code, effective_position, referral_count FROM signups WHERE campaign_id=? AND email=?').bind(body.campaign_id, email).first<any>();
      if (existing) return json({ already_signed_up: true, position: existing.effective_position, referral_code: existing.referral_code, referral_count: existing.referral_count, total: campaign.total_signups });

      const id = uid();
      const code = refCode();
      const position = campaign.total_signups + 1;
      let effectivePosition = position;
      let referredBy: string | null = null;

      // Process referral
      if (body.ref && campaign.referral_enabled) {
        const referrer = await env.DB.prepare('SELECT id, referral_count, effective_position FROM signups WHERE campaign_id=? AND referral_code=?').bind(body.campaign_id, body.ref).first<any>();
        if (referrer) {
          referredBy = referrer.id;
          const newRefCount = (referrer.referral_count || 0) + 1;
          const boost = newRefCount * (campaign.positions_per_referral || 5);
          await env.DB.prepare('UPDATE signups SET referral_count=?, priority_boost=?, effective_position=MAX(1, position - ?) WHERE id=?')
            .bind(newRefCount, boost, boost, referrer.id).run();
          await env.DB.prepare('INSERT INTO referrals (campaign_id, referrer_id, referee_id) VALUES (?, ?, ?)').bind(body.campaign_id, referrer.id, id).run();

          // Check milestones
          const milestones = await env.DB.prepare('SELECT * FROM milestones WHERE campaign_id=? AND referral_threshold<=? ORDER BY referral_threshold').bind(body.campaign_id, newRefCount).all();
          for (const ms of (milestones.results || []) as any[]) {
            await env.DB.prepare('INSERT OR IGNORE INTO milestone_unlocks (milestone_id, signup_id) VALUES (?, ?)').bind(ms.id, referrer.id).run();
          }
        }
      }

      const ipHash = await hashIP(ip);
      await env.DB.prepare('INSERT INTO signups (id, campaign_id, tenant_id, email, name, position, referral_code, referred_by, effective_position, custom_data, ip_hash, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))')
        .bind(id, body.campaign_id, campaign.tenant_id, email, body.name ? sanitize(body.name, 200) : null, position, code, referredBy, effectivePosition, body.custom_data ? JSON.stringify(body.custom_data) : '{}', ipHash).run();
      await env.DB.prepare('UPDATE campaigns SET total_signups = total_signups + 1 WHERE id=?').bind(body.campaign_id).run();

      // Send confirmation email (fire and forget)
      if (campaign.confirmation_email) {
        (async () => {
          try {
            const referralLink = `https://echo-waitlist.bmcii1976.workers.dev/join-page/${campaign.slug}?ref=${code}`;
            await env.EMAIL_SENDER.fetch('https://email/send', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                to: email, from_name: campaign.name || 'Waitlist', subject: `You're #${position} on the ${campaign.name} waitlist!`,
                html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px"><h2>You're on the list!</h2><p>Your position: <strong>#${position}</strong></p><p>Share your referral link to move up:</p><p style="background:#f1f5f9;padding:12px;border-radius:8px;word-break:break-all"><a href="${referralLink}">${referralLink}</a></p><p>Every friend who joins moves you ${campaign.positions_per_referral || 5} spots closer to the front.</p></div>`
              })
            });
          } catch {}
        })();
      }

      return json({ position, effective_position: effectivePosition, referral_code: code, total: campaign.total_signups + 1 });
    }

    // ── Public: Check position ──
    if (m === 'GET' && p === '/check') {
      const email = url.searchParams.get('email');
      const cid = url.searchParams.get('campaign_id');
      if (!email || !cid) return err('email and campaign_id required');
      const signup = await env.DB.prepare('SELECT position, effective_position, referral_code, referral_count, status FROM signups WHERE campaign_id=? AND email=?').bind(cid, email.toLowerCase().trim()).first();
      if (!signup) return err('Not found', 404);
      const total = await env.DB.prepare('SELECT total_signups FROM campaigns WHERE id=?').bind(cid).first<{total_signups:number}>();
      return json({ ...signup, total: total?.total_signups || 0 });
    }

    // ── Public: Referral stats ──
    if (m === 'GET' && p === '/referral-stats') {
      const code = url.searchParams.get('code');
      const cid = url.searchParams.get('campaign_id');
      if (!code || !cid) return err('code and campaign_id required');
      const signup = await env.DB.prepare('SELECT id, position, effective_position, referral_count FROM signups WHERE campaign_id=? AND referral_code=?').bind(cid, code).first<any>();
      if (!signup) return err('Not found', 404);
      const milestones = await env.DB.prepare('SELECT m.*, CASE WHEN mu.milestone_id IS NOT NULL THEN 1 ELSE 0 END as unlocked FROM milestones m LEFT JOIN milestone_unlocks mu ON m.id=mu.milestone_id AND mu.signup_id=? WHERE m.campaign_id=? ORDER BY m.referral_threshold').bind(signup.id, cid).all();
      return json({ position: signup.effective_position, referral_count: signup.referral_count, milestones: milestones.results || [] });
    }

    // ── Public: Embeddable widget ──
    if (m === 'GET' && p === '/widget.js') {
      const cid = url.searchParams.get('id');
      if (!cid) return err('Missing id');
      const campaign = await env.DB.prepare('SELECT name, brand_color, total_signups, slug FROM campaigns WHERE id=?').bind(cid).first<any>();
      const color = campaign?.brand_color || '#14b8a6';
      const name = campaign?.name || 'Waitlist';
      const total = campaign?.total_signups || 0;
      const js = `(function(){var d=document,w=d.createElement('div');w.id='echo-wl-widget';w.innerHTML='<div style="font-family:sans-serif;max-width:400px;padding:24px;border-radius:12px;border:1px solid #e2e8f0;background:#fff"><h3 style="margin:0 0 4px;font-size:18px;color:#0f172a">Join the ${name.replace(/'/g,"\\'")} Waitlist</h3><p style="margin:0 0 16px;font-size:13px;color:#64748b">${total.toLocaleString()}+ already signed up</p><form id="echo-wl-form"><input id="echo-wl-email" type="email" placeholder="your@email.com" required style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #e2e8f0;font-size:14px;margin-bottom:8px"/><input id="echo-wl-name" type="text" placeholder="Your name (optional)" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #e2e8f0;font-size:14px;margin-bottom:12px"/><button type="submit" style="width:100%;padding:10px;border-radius:8px;border:none;background:${color};color:#fff;font-size:14px;font-weight:600;cursor:pointer">Join Waitlist</button></form><div id="echo-wl-result" style="display:none;margin-top:12px;padding:12px;border-radius:8px;background:#f0fdf4;text-align:center"></div><p style="margin:8px 0 0;font-size:11px;color:#94a3b8;text-align:center">Powered by <a href="https://echo-ept.com/waitlist" style="color:${color};text-decoration:none">Echo Waitlist</a></p></div>';var c=d.currentScript;var ref=new URLSearchParams(location.search).get("ref")||"";c.parentNode.insertBefore(w,c.nextSibling);d.getElementById("echo-wl-form").addEventListener("submit",function(e){e.preventDefault();var res=d.getElementById("echo-wl-result");var email=d.getElementById("echo-wl-email").value;var name=d.getElementById("echo-wl-name").value;res.style.display="block";res.innerHTML="<span style=\\'color:#64748b\\'>Joining...</span>";fetch(c.src.split("/widget.js")[0]+"/join",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({campaign_id:"${cid}",email:email,name:name||undefined,ref:ref||undefined})}).then(function(r){return r.json()}).then(function(d){if(d.position){res.innerHTML="<strong style=\\'color:#0f172a\\'>You are #"+d.effective_position+"</strong><br><span style=\\'font-size:12px;color:#64748b\\'>Share to move up: <input readonly value=\\'"+location.origin+location.pathname+"?ref="+d.referral_code+"\\' style=\\'width:100%;margin-top:4px;padding:6px;border:1px solid #e2e8f0;border-radius:4px;font-size:11px\\' onclick=\\'this.select()\\'/></span>";}else if(d.already_signed_up){res.innerHTML="<span style=\\'color:${color}\\'>Already signed up! Position #"+d.position+"</span>";}else{res.innerHTML="<span style=\\'color:#ef4444\\'>"+(d.error||"Error")+"</span>";}}).catch(function(){res.innerHTML="<span style=\\'color:#ef4444\\'>Network error</span>";});});})();`;
      return new Response(js, { headers: { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' } });
    }

    // ── Public: Campaign info ──
    if (m === 'GET' && p.match(/^\/campaign\/[a-zA-Z0-9-]+$/)) {
      const slug = p.split('/')[2];
      const campaign = await env.DB.prepare('SELECT id, name, slug, description, total_signups, launch_date, brand_color, logo_url, status FROM campaigns WHERE slug=? AND status=?').bind(slug, 'active').first();
      return campaign ? json(campaign) : err('Not found', 404);
    }

    // ── Authenticated endpoints ──
    if (!authOk(req, env)) return err('Unauthorized', 401);
    const tid = req.headers.get('X-Tenant-ID') || url.searchParams.get('tenant_id') || '';

    // ── Campaigns CRUD ──
    if (m === 'POST' && p === '/api/campaigns') {
      const body = await req.json<any>();
      const id = uid();
      const slug = body.slug || body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
      await env.DB.prepare('INSERT INTO campaigns (id, tenant_id, name, slug, description, launch_date, max_signups, custom_fields, brand_color, referral_enabled, positions_per_referral, confirmation_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, tid, sanitize(body.name), slug, body.description ? sanitize(body.description) : null, body.launch_date || null, body.max_signups || null, body.custom_fields ? JSON.stringify(body.custom_fields) : '[]', body.brand_color || '#14b8a6', body.referral_enabled !== false ? 1 : 0, body.positions_per_referral || 5, body.confirmation_email !== false ? 1 : 0).run();
      return json({ id, slug, widget_tag: `<script src="https://echo-waitlist.bmcii1976.workers.dev/widget.js?id=${id}"></script>` });
    }
    if (m === 'GET' && p === '/api/campaigns') {
      const r = await env.DB.prepare('SELECT * FROM campaigns WHERE tenant_id=? ORDER BY created_at DESC').bind(tid).all();
      return json({ campaigns: r.results || [] });
    }
    if (m === 'GET' && p.match(/^\/api\/campaigns\/[a-zA-Z0-9]+$/)) {
      const id = p.split('/')[3];
      const r = await env.DB.prepare('SELECT * FROM campaigns WHERE id=? AND tenant_id=?').bind(id, tid).first();
      return r ? json(r) : err('Not found', 404);
    }
    if (m === 'PUT' && p.match(/^\/api\/campaigns\/[a-zA-Z0-9]+$/)) {
      const id = p.split('/')[3];
      const body = await req.json<any>();
      const sets: string[] = []; const vals: any[] = [];
      if (body.name) { sets.push('name=?'); vals.push(sanitize(body.name)); }
      if (body.description !== undefined) { sets.push('description=?'); vals.push(sanitize(body.description)); }
      if (body.status) { sets.push('status=?'); vals.push(body.status); }
      if (body.launch_date) { sets.push('launch_date=?'); vals.push(body.launch_date); }
      if (body.brand_color) { sets.push('brand_color=?'); vals.push(body.brand_color); }
      if (body.max_signups !== undefined) { sets.push('max_signups=?'); vals.push(body.max_signups); }
      if (body.referral_enabled !== undefined) { sets.push('referral_enabled=?'); vals.push(body.referral_enabled ? 1 : 0); }
      if (!sets.length) return err('Nothing to update');
      vals.push(id, tid);
      await env.DB.prepare(`UPDATE campaigns SET ${sets.join(',')} WHERE id=? AND tenant_id=?`).bind(...vals).run();
      return json({ ok: true });
    }

    // ── Signups management ──
    if (m === 'GET' && p.match(/^\/api\/campaigns\/[a-zA-Z0-9]+\/signups$/)) {
      const cid = p.split('/')[3];
      const status = url.searchParams.get('status') || 'active';
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const sort = url.searchParams.get('sort') === 'referrals' ? 'referral_count DESC' : 'effective_position ASC';
      const r = await env.DB.prepare(`SELECT * FROM signups WHERE campaign_id=? AND tenant_id=? AND status=? ORDER BY ${sort} LIMIT ? OFFSET ?`).bind(cid, tid, status, limit, offset).all();
      const total = await env.DB.prepare('SELECT COUNT(*) as c FROM signups WHERE campaign_id=? AND status=?').bind(cid, status).first<{c:number}>();
      return json({ signups: r.results || [], total: total?.c || 0 });
    }

    // Invite (mark as invited)
    if (m === 'POST' && p.match(/^\/api\/signups\/[a-zA-Z0-9]+\/invite$/)) {
      const id = p.split('/')[3];
      await env.DB.prepare("UPDATE signups SET status='invited', invited_at=datetime('now') WHERE id=? AND tenant_id=?").bind(id, tid).run();
      return json({ ok: true });
    }

    // Bulk invite top N
    if (m === 'POST' && p.match(/^\/api\/campaigns\/[a-zA-Z0-9]+\/invite-batch$/)) {
      const cid = p.split('/')[3];
      const body = await req.json<{ count: number }>().catch(() => ({ count: 10 }));
      const count = Math.min(body?.count || 10, 100);
      const signups = await env.DB.prepare("SELECT * FROM signups WHERE campaign_id=? AND tenant_id=? AND status='active' ORDER BY effective_position ASC LIMIT ?").bind(cid, tid, count).all();
      let invited = 0;
      for (const s of (signups.results || []) as any[]) {
        await env.DB.prepare("UPDATE signups SET status='invited', invited_at=datetime('now') WHERE id=?").bind(s.id).run();
        invited++;
      }
      return json({ invited });
    }

    // Export signups as JSON
    if (m === 'GET' && p.match(/^\/api\/campaigns\/[a-zA-Z0-9]+\/export$/)) {
      const cid = p.split('/')[3];
      const r = await env.DB.prepare('SELECT email, name, position, effective_position, referral_code, referral_count, status, custom_data, created_at FROM signups WHERE campaign_id=? AND tenant_id=? ORDER BY effective_position ASC').bind(cid, tid).all();
      return json({ signups: r.results || [] });
    }

    // ── Milestones ──
    if (m === 'POST' && p === '/api/milestones') {
      const body = await req.json<any>();
      const id = uid();
      await env.DB.prepare('INSERT INTO milestones (id, campaign_id, name, referral_threshold, reward_type, reward_value) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, body.campaign_id, sanitize(body.name), body.referral_threshold, body.reward_type || 'badge', body.reward_value || null).run();
      return json({ id });
    }
    if (m === 'GET' && p.match(/^\/api\/campaigns\/[a-zA-Z0-9]+\/milestones$/)) {
      const cid = p.split('/')[3];
      const r = await env.DB.prepare('SELECT * FROM milestones WHERE campaign_id=? ORDER BY referral_threshold').bind(cid).all();
      return json({ milestones: r.results || [] });
    }

    // ── Analytics ──
    if (m === 'GET' && p.match(/^\/api\/campaigns\/[a-zA-Z0-9]+\/analytics$/)) {
      const cid = p.split('/')[3];
      const campaign = await env.DB.prepare('SELECT total_signups FROM campaigns WHERE id=? AND tenant_id=?').bind(cid, tid).first<any>();
      const active = await env.DB.prepare("SELECT COUNT(*) as c FROM signups WHERE campaign_id=? AND status='active'").bind(cid).first<{c:number}>();
      const invited = await env.DB.prepare("SELECT COUNT(*) as c FROM signups WHERE campaign_id=? AND status='invited'").bind(cid).first<{c:number}>();
      const converted = await env.DB.prepare("SELECT COUNT(*) as c FROM signups WHERE campaign_id=? AND status='converted'").bind(cid).first<{c:number}>();
      const totalRefs = await env.DB.prepare('SELECT COUNT(*) as c FROM referrals WHERE campaign_id=?').bind(cid).first<{c:number}>();
      const topReferrers = await env.DB.prepare('SELECT email, name, referral_count, effective_position FROM signups WHERE campaign_id=? AND referral_count > 0 ORDER BY referral_count DESC LIMIT 10').bind(cid).all();
      const daily = await env.DB.prepare("SELECT * FROM analytics_daily WHERE campaign_id=? ORDER BY date DESC LIMIT 30").bind(cid).all();
      const growth = await env.DB.prepare("SELECT date(created_at) as date, COUNT(*) as signups FROM signups WHERE campaign_id=? AND created_at > datetime('now', '-30 days') GROUP BY date(created_at) ORDER BY date").bind(cid).all();
      return json({
        total: campaign?.total_signups || 0, active: active?.c || 0,
        invited: invited?.c || 0, converted: converted?.c || 0,
        total_referrals: totalRefs?.c || 0, viral_coefficient: (campaign?.total_signups || 0) > 0 ? ((totalRefs?.c || 0) / (campaign?.total_signups || 1)).toFixed(2) : '0',
        top_referrers: topReferrers.results || [], daily: daily.results || [], growth: growth.results || []
      });
    }

    return err('Not found', 404);
    } catch (e: unknown) {
      const msg = (e as Error).message || String(e);
      if (msg.includes('JSON')) return err('Invalid JSON body', 400);
      console.error(`[echo-waitlist] ${msg}`);
      return err('Internal server error', 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const today = new Date().toISOString().split('T')[0];
    const campaigns = await env.DB.prepare("SELECT id FROM campaigns WHERE status='active'").all();
    for (const c of (campaigns.results || []) as any[]) {
      const cid = c.id;
      const signups = await env.DB.prepare("SELECT COUNT(*) as c FROM signups WHERE campaign_id=? AND date(created_at)=?").bind(cid, today).first<{c:number}>();
      const referrals = await env.DB.prepare("SELECT COUNT(*) as c FROM referrals WHERE campaign_id=? AND date(created_at)=?").bind(cid, today).first<{c:number}>();
      const invites = await env.DB.prepare("SELECT COUNT(*) as c FROM signups WHERE campaign_id=? AND date(invited_at)=?").bind(cid, today).first<{c:number}>();
      const conversions = await env.DB.prepare("SELECT COUNT(*) as c FROM signups WHERE campaign_id=? AND date(converted_at)=?").bind(cid, today).first<{c:number}>();
      await env.DB.prepare('INSERT INTO analytics_daily (campaign_id, date, signups, referrals, invites_sent, conversions) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(campaign_id, date) DO UPDATE SET signups=excluded.signups, referrals=excluded.referrals, invites_sent=excluded.invites_sent, conversions=excluded.conversions')
        .bind(cid, today, signups?.c || 0, referrals?.c || 0, invites?.c || 0, conversions?.c || 0).run();
    }
  }
};
