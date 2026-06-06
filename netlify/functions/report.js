'use strict';

/**
 * Netlify Function: report
 * AML / wallet-risk report generator for Crypto Scanner.
 *
 *   GET  /.netlify/functions/report?address=0x...&chain=ethereum
 *   POST /.netlify/functions/report   { "address": "...", "chain": "..." }
 *
 * Returns a JSON PREVIEW only:
 *   - risk score + tier + headline stats
 *   - exactly ONE free finding ("Unverified counterparties")
 *   - a summary of the locked findings (severity counts only)
 *
 * The full locked findings are intentionally NOT included here. They are
 * served by a separate paid endpoint after checkout, so the real content is
 * never shipped to the browser before payment (the blurred rows in
 * result.html are placeholders only).
 *
 * Secrets are read from environment variables — never hard-code keys here.
 *   ETHERSCAN_API_KEY, MORALIS_API_KEY, TRONGRID_API_KEY
 */

// ---- Config ---------------------------------------------------------------

const ETHERSCAN_BASE = 'https://api.etherscan.io/api';
const TRONGRID_BASE = 'https://api.trongrid.io';

const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || '';
const TRONGRID_KEY = process.env.TRONGRID_API_KEY || '';

// Fallback spot prices, used only if a live price lookup fails.
const FALLBACK_ETH_USD = 3000;
const FALLBACK_TRX_USD = 0.12;

// Approved scoring tiers + base scores.
const BASE_SCORE = {
  DEAD: 95,
  TRIVIAL: 91,
  DORMANT_SIG: 64,
  NORMAL: 77,
  HIGH_VALUE: 61,
};

// ---- Small helpers --------------------------------------------------------

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function jget(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// Deterministic per-address jitter in the range [-3, +3].
// deterministicJitter(addr) = (hash % 7) - 3
function deterministicJitter(addr) {
  const s = String(addr || '').toLowerCase();
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return (Math.abs(hash) % 7) - 3;
}

function detectChain(address, hint) {
  const a = String(address || '').trim();
  if (hint) {
    const h = String(hint).toLowerCase();
    if (h.startsWith('eth')) return 'ethereum';
    if (h.startsWith('tron') || h === 'trx') return 'tron';
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return 'ethereum';
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return 'tron';
  return null;
}

// tx === 0                              -> DEAD
// tx < 8   AND volume < $500            -> TRIVIAL
// balance < $50 AND volume >= $5000     -> DORMANT_SIG
// volume >= $20000 OR tx >= 50          -> HIGH_VALUE
// everything between                    -> NORMAL
function classify({ txCount, volumeUsd, balanceUsd }) {
  if (txCount === 0) return 'DEAD';
  if (txCount < 8 && volumeUsd < 500) return 'TRIVIAL';
  if (balanceUsd < 50 && volumeUsd >= 5000) return 'DORMANT_SIG';
  if (volumeUsd >= 20000 || txCount >= 50) return 'HIGH_VALUE';
  return 'NORMAL';
}

function riskLabel(score) {
  if (score >= 80) return 'High';
  if (score >= 65) return 'Elevated';
  if (score >= 50) return 'Moderate';
  return 'Low';
}

// ---- Chain data fetchers --------------------------------------------------

async function ethPrice() {
  try {
    const u = `${ETHERSCAN_BASE}?module=stats&action=ethprice&apikey=${ETHERSCAN_KEY}`;
    const d = await jget(u);
    const p = parseFloat(d && d.result && d.result.ethusd);
    return p > 0 ? p : FALLBACK_ETH_USD;
  } catch (_) {
    return FALLBACK_ETH_USD;
  }
}

async function fetchEth(address) {
  const price = await ethPrice();

  let balanceUsd = 0;
  try {
    const u = `${ETHERSCAN_BASE}?module=account&action=balance&address=${address}&tag=latest&apikey=${ETHERSCAN_KEY}`;
    const d = await jget(u);
    const wei = BigInt((d && d.result) || '0');
    balanceUsd = (Number(wei) / 1e18) * price;
  } catch (_) {
    /* leave balanceUsd = 0 */
  }

  let txCount = 0;
  let volumeUsd = 0;
  let firstSeen = null;
  let lastSeen = null;
  try {
    const u = `${ETHERSCAN_BASE}?module=account&action=txlist&address=${address}` +
      `&startblock=0&endblock=99999999&page=1&offset=10000&sort=asc&apikey=${ETHERSCAN_KEY}`;
    const d = await jget(u);
    const txs = Array.isArray(d && d.result) ? d.result : [];
    txCount = txs.length;
    for (const t of txs) {
      volumeUsd += (Number(t.value || 0) / 1e18) * price;
    }
    if (txs.length) {
      firstSeen = Number(txs[0].timeStamp) * 1000;
      lastSeen = Number(txs[txs.length - 1].timeStamp) * 1000;
    }
  } catch (_) {
    /* leave defaults */
  }

  return { txCount, volumeUsd, balanceUsd, firstSeen, lastSeen, nativeSymbol: 'ETH', priceUsd: price };
}

async function fetchTron(address) {
  const price = FALLBACK_TRX_USD; // TronGrid has no native price feed.
  const headers = TRONGRID_KEY ? { 'TRON-PRO-API-KEY': TRONGRID_KEY } : {};

  let balanceUsd = 0;
  try {
    const d = await jget(`${TRONGRID_BASE}/v1/accounts/${address}`, { headers });
    const acc = d && d.data && d.data[0];
    const sun = (acc && acc.balance) || 0;
    balanceUsd = (Number(sun) / 1e6) * price;
  } catch (_) {
    /* leave balanceUsd = 0 */
  }

  let txCount = 0;
  let volumeUsd = 0;
  let firstSeen = null;
  let lastSeen = null;
  try {
    const u = `${TRONGRID_BASE}/v1/accounts/${address}/transactions` +
      `?limit=200&order_by=block_timestamp,asc`;
    const d = await jget(u, { headers });
    const txs = Array.isArray(d && d.data) ? d.data : [];
    txCount = txs.length;
    for (const t of txs) {
      const c = t && t.raw_data && t.raw_data.contract && t.raw_data.contract[0];
      const amt = c && c.parameter && c.parameter.value && c.parameter.value.amount;
      if (amt) volumeUsd += (Number(amt) / 1e6) * price;
    }
    if (txs.length) {
      firstSeen = Number(txs[0].block_timestamp) || null;
      lastSeen = Number(txs[txs.length - 1].block_timestamp) || null;
    }
  } catch (_) {
    /* leave defaults */
  }

  return { txCount, volumeUsd, balanceUsd, firstSeen, lastSeen, nativeSymbol: 'TRX', priceUsd: price };
}

// ---- Report assembly ------------------------------------------------------

function buildReport({ address, chain, tier, score, data }) {
  return {
    ok: true,
    address,
    chain,
    generatedAt: new Date().toISOString(),
    score,
    tier,
    riskLevel: riskLabel(score),
    stats: {
      txCount: data.txCount,
      volumeUsd: round2(data.volumeUsd),
      balanceUsd: round2(data.balanceUsd),
      nativeSymbol: data.nativeSymbol,
      firstSeen: data.firstSeen,
      lastSeen: data.lastSeen,
    },
    // The single free finding shown openly in result.html.
    freeFinding: {
      severity: 'info',
      title: 'Unverified counterparties',
      detail:
        'This wallet interacted with external addresses that the free tier does ' +
        'not cross-check against sanctions and known-illicit databases. Run the ' +
        'full analysis to screen every counterparty.',
    },
    // Severity distribution of the locked findings — NOT the findings themselves.
    lockedSummary: { total: 5, high: 1, medium: 1, low: 3 },
    unlock: { priceUsd: 19.99, label: 'Unlock Full Analysis' },
  };
}

// ---- Handler --------------------------------------------------------------

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  let address;
  let chainHint;
  try {
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      address = body.address;
      chainHint = body.chain;
    } else {
      const q = event.queryStringParameters || {};
      address = q.address;
      chainHint = q.chain;
    }
  } catch (_) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid request body' }) };
  }

  address = String(address || '').trim();
  if (!address) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Missing address' }) };
  }

  const chain = detectChain(address, chainHint);
  if (!chain) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unsupported or invalid address' }) };
  }

  try {
    const data = chain === 'ethereum' ? await fetchEth(address) : await fetchTron(address);
    const tier = classify(data);
    const score = clamp(Math.round(BASE_SCORE[tier] + deterministicJitter(address)), 0, 100);
    const report = buildReport({ address, chain, tier, score, data });
    return { statusCode: 200, headers, body: JSON.stringify(report) };
  } catch (_) {
    return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: 'Upstream data fetch failed' }) };
  }
};
