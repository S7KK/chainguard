'use strict';

/**
 * monitor-check — scheduled every 12h (see netlify.toml).
 * Re-scans each active, non-expired monitor via the existing /report endpoint,
 * and if the wallet's risk_score RISES by >= 10 since the last check, records an
 * alert and emails the owner. (Risk up = user-facing confidence down.)
 *
 * Fits the existing account-based schema:
 *   monitors(user_id, address, network, last_score, ...)
 *   scans use risk_score; profiles hold the email.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *      URL or SITE_URL (Netlify-provided site URL),
 *      RESEND_API_KEY + ALERT_FROM_EMAIL (optional, for email alerts)
 */

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE = (process.env.SITE_URL || process.env.URL || '').replace(/\/$/, '');
const RISE_THRESHOLD = 10;   // alert when risk_score increases by this much
const BATCH = 50;

async function sb(path, opts) {
  opts = opts || {};
  const res = await fetch(SB_URL + '/rest/v1/' + path, {
    method: opts.method || 'GET',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || '',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}
  if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + text);
  return data;
}

async function rescan(address) {
  const r = await fetch(SITE + '/.netlify/functions/report?addr=' + encodeURIComponent(address));
  const d = await r.json();
  if (!d || d.error) return null;
  const s = (d.risk_score != null) ? d.risk_score : d.score;
  return Number.isFinite(s) ? s : null;
}

async function emailFor(userId) {
  if (!userId) return null;
  const rows = await sb('profiles?id=eq.' + encodeURIComponent(userId) + '&select=email');
  return rows && rows[0] ? rows[0].email : null;
}

async function sendEmail(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_FROM_EMAIL || 'Crypto Scanner <alerts@cryptoscanner.app>';
  if (!key || !to) { console.log('[email skipped]', to, subject); return; }
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
  } catch (e) { console.log('[email error]', String(e)); }
}

function alertHtml(m, oldScore, newScore, delta) {
  const short = m.address.slice(0, 8) + '…' + m.address.slice(-6);
  return '<div style="font-family:sans-serif;max-width:520px">' +
    '<h2 style="color:#EF4444">⚠️ Wallet risk increased</h2>' +
    '<p>Monitored wallet <code>' + short + '</code> (' + m.network + ') rose <b>+' + delta +
    '</b> in risk — from ' + oldScore + ' to <b>' + newScore + '</b>.</p>' +
    '<p>This usually means new exposure to risky or sanctioned counterparties.</p>' +
    (SITE ? '<p><a href="' + SITE + '/dashboard">Open dashboard →</a></p>' : '') +
    '</div>';
}

exports.handler = async () => {
  const nowIso = new Date().toISOString();
  let processed = 0, alerted = 0;

  try {
    const due = await sb(
      'monitors?active=eq.true' +
      '&or=(next_check_at.is.null,next_check_at.lte.' + nowIso + ')' +
      '&or=(expires_at.is.null,expires_at.gte.' + nowIso + ')' +
      '&select=*&limit=' + BATCH
    );

    for (const m of (due || [])) {
      processed++;
      const next = new Date(Date.now() + (m.interval_hours || 12) * 3600000).toISOString();

      let newScore = null;
      try { newScore = await rescan(m.address); } catch (_) {}

      if (newScore == null) {
        await sb('monitors?id=eq.' + m.id, { method: 'PATCH', body: { next_check_at: next } });
        continue;
      }

      const oldScore = (m.last_score == null) ? newScore : m.last_score;
      const delta = newScore - oldScore;   // risk rose => positive

      if (m.last_score != null && delta >= RISE_THRESHOLD) {
        await sb('alerts', {
          method: 'POST',
          body: { monitor_id: m.id, user_id: m.user_id, address: m.address,
                  old_score: oldScore, new_score: newScore, delta: delta },
        });
        const to = await emailFor(m.user_id);
        await sendEmail(to, '⚠️ Wallet risk increased — Crypto Scanner',
                        alertHtml(m, oldScore, newScore, delta));
        alerted++;
      }

      await sb('monitors?id=eq.' + m.id, {
        method: 'PATCH',
        body: { last_score: newScore, next_check_at: next },
      });
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, processed, alerted }) };
  } catch (e) {
    console.log('[monitor-check error]', String(e));
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Server error' }) };
  }
};
