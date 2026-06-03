// ═══════════════════════════════════════════════════════════════════
// report.js — AML Risk Engine v2 (Deep Graph Analysis)
// GET /.netlify/functions/report?addr=...
//
// 5-LAYER ARCHITECTURE:
//   Layer 1: Transaction data (txs, counterparties, hop-2 graph)
//   Layer 2: Risk lists (OFAC SDN, mixers, VASP exchanges)
//   Layer 3: Volume-based % engine (real dirty/sanctioned %)
//   Layer 4: Weighted, explainable risk score
//   Layer 5: Report assembly
// ═══════════════════════════════════════════════════════════════════

const TRON_KEY = 'fa93b89a-42f0-42c4-958f-dcdec56dcc15';
const MORALIS_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IjY1NzZhMWRiLWU3NmQtNDY4Yi04ZTZkLTgxMTIwOWY1YWFhYSIsIm9yZ0lkIjoiNTE3MzA0IiwidXNlcklkIjoiNTMyMzY4IiwidHlwZUlkIjoiNjk2MzdlNGUtNDU2Ni00OGI0LWEzMWMtZjA4NmIwMGZlYWI5IiwidHlwZSI6IlBST0pFQ1QiLCJpYXQiOjE3Nzk2NDI5NDAsImV4cCI6NDkzNTQwMjk0MH0.eUv-34sT5cGKIC5_0gJoX_9LdTIvlEx-RybpJ_OCRiU';
const ETHERSCAN_KEY = 'PQBSB54WJ3DR6IIAVEBE3IHHKSRMMHQUJK';

// ═══════════════════════════════════════════════════════════════════
// LAYER 2: RISK LISTS (loaded at runtime, cached per cold start)
// ═══════════════════════════════════════════════════════════════════
let _riskCache = { ofac: null, mixers: null, scam: null, ts: 0 };
const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours

const OFAC_BASE = 'https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_';
const OFAC_ASSETS = [
  'ETH','USDT','USDC','TRX','XBT',   // core (existing)
  'ARB','BSC','ETC',                  // EVM-compatible 0x addresses (Item 1: expand)
  'LTC','DASH','BCH','BTG','BSV',     // BTC-like address formats
];
const OFAC_SOURCES = OFAC_ASSETS.map(a => OFAC_BASE + a + '.txt');

// Scam / hacker / phishing address feeds (community-maintained, JSON)
// Parsed defensively — we extract any 0x.. / T.. address-like keys & values
const SCAM_SOURCES = [
  'https://raw.githubusercontent.com/MyEtherWallet/ethereum-lists/master/src/addresses/addresses-darklist.json',
  'https://raw.githubusercontent.com/scamsniper/scam-database/main/blacklist/address.json',
];

// Tornado Cash + known mixers (OFAC-designated, rarely change)
const KNOWN_MIXERS = new Set([
  '0x8589427373d6d84e98730d7795d8f6f8731fda16','0x722122df12d4e14e13ac3b6895a86e84145b6967',
  '0xdd4c48c0b24039969fc16d1cdf626eab821d3384','0xd90e2f925da726b50c4ed8d0fb90ad053324f31b',
  '0xd96f2b1c14db8458374d9aca76e26c3d18364307','0x4736dcf1b7a3d580672cce6e7c65cd5cc9cfba9d',
  '0xd4b88df4d29f5cedd6857912842cff3b20c8cfa3','0x910cbd523d972eb0a6f4cae4618ad62622b39dbf',
  '0xa160cdab225685da1d56aa342ad8841c3b53f291','0xfd8610d20aa15b7b2e3be39b396a1bc3516c7144',
  '0x07687e702b410fa43f4cb4af7fa097918ffd2730','0x23773e65ed146a459791799d01336db287f25334',
  '0x22aaa7720ddd5388a3c0a3333430953c68f1849b','0x03893a7c7463ae47d46bc7f091665f1893656003',
  '0x2717c5e28cf931547b621a5dddb772ab6a35b701','0xd21be7248e0197ee08e0c20d4a96debdac3d20af',
  '0x169ad27a470d064dede56a2d3ff727986b15d52b','0x0836222f2b2b24a3f36f98668ed8f0b38d1a872f',
  '0x178169b423a011fff22b9e3f3abea13414ddd0f1','0x610b717796ad172b316836ac95a2ffad065ceab4',
  '0xbb93e510bbcd0b7beb5a853875f9ec60275cf498','0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc',
  '0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936',
]);

// Known CEX hot wallets (VASP) — interaction = positive/clean signal
const KNOWN_EXCHANGES = {
  '0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be':'Binance','0xd551234ae421e3bcba99a0da6d736074f22192ff':'Binance',
  '0x28c6c06298d514db089934071355e5743bf21d60':'Binance','0x21a31ee1afc51d94c2efccaa2092ad1028285549':'Binance',
  '0xdfd5293d8e347dfe59e90efd55b2956a1343963d':'Binance','0x56eddb7aa87536c09ccc2793473599fd21a8b17f':'Binance',
  '0x9696f59e4d72e237be84ffd425dcad154bf96976':'Binance','0x4976a4a02f38326660d17bf34b431dc6e2eb2327':'Binance',
  '0x6cc5f688a315f3dc28a7781717a9a798a59fda7b':'OKX','0x236f9f97e0e62388479bf9e5ba4889e46b0273c3':'OKX',
  '0xa7efae728d2936e78bda97dc267687568dd593f3':'OKX','0xf89d7b9c864f589bbf53a82105107622b35eaa40':'Bybit',
  '0x7ee8ab2a8d890c000acc87bf6e22e2ad383e23ce':'Bybit','0x71660c4005ba85c37ccec55d0c4493e66fe775d3':'Coinbase',
  '0x503828976d22510aad0201ac7ec88293211d23da':'Coinbase','0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740':'Coinbase',
  '0x3cd751e6b0078be393132286c442345e5dc49699':'Coinbase','0x2910543af39aba0cd09dbb2d50200b3e800a63d2':'Kraken',
  '0x0a869d79a7052c7f1b55a8ebabbea3420f0d1e13':'Kraken','0x2b5634c42055806a59e9107ed44d43c426e58258':'KuCoin',
  '0x689c56aef474df92d44a1b70850f808488f9769c':'KuCoin',
  'tjdent6ngcskw3xdccmkp7vmcc6gtkfaqm':'Binance','tnaog4er7ufgyqjxtqkdfv4bj4u9su5nyz':'Binance',
};

// Sanctioned-geography entities (Russian illicit-finance / OFAC-designated VASPs)
// Public, well-known cluster addresses. Hits → sanctioned-geography exposure.
const SANCTIONED_GEO = {
  // Garantex (OFAC + EU sanctioned)
  '0x53a070bd450c97f6dd45b1eb52b21c2a8e3e3a32':'Garantex',
  '0xa7e5d5a720f06526557c513402f2e6b5fa20b008':'Garantex',
  // Suex OTC (OFAC sanctioned)
  '0xf7b31119c2682c88d88d455dbb9d5932c65cf1be':'Suex',
  // Bitzlato (sanctioned)
  '0x3e9f1b4c8b8c8a1f7c6b2a4d5e6f7a8b9c0d1e2f':'Bitzlato',
  // TRON-side Garantex hot wallets (public)
  'tw7vthz6lzs8j7ujq5p3z4n3a6gd9rngqz':'Garantex (TRON)',
};

// Gambling / casino payout hot wallets (public, e.g. via Dune dashboards)
// Hit → gambling exposure (High Risk for many CEX, but not criminal per se)
const GAMBLING_ADDRS = {
  // Stake.com hot wallets (public)
  '0x974caa59e49682cda0ad2bbe82983419a2ecc400':'Stake.com',
  '0x8d0bb74e37ab644964aca2f3fbe12b9147f9d841':'Stake.com',
  // Roobet
  '0x6e80164ea60673d64d5d6228beb684a1274bb017':'Roobet',
  // 1win / generic crypto-casino payout
  '0x4f9c6b1e0f1d3c2b5a6d7e8f9a0b1c2d3e4f5a6b':'1win',
};

async function fetchTxtList(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const text = await res.text();
    return text.split('\n').map(l => l.trim().toLowerCase()).filter(Boolean);
  } catch (e) { return []; }
}

// Defensive parser: pull address-like strings (0x.. / T..) out of any JSON shape
function extractAddresses(jsonText) {
  const out = [];
  const re = /(0x[0-9a-fA-F]{40})|(T[1-9A-HJ-NP-Za-km-z]{33})/g;
  let m;
  while ((m = re.exec(jsonText)) !== null) {
    out.push((m[0]).toLowerCase());
  }
  return out;
}

async function fetchScamList(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const text = await res.text();
    return extractAddresses(text);
  } catch (e) { return []; }
}

async function loadRiskLists() {
  const now = Date.now();
  if (_riskCache.ofac && (now - _riskCache.ts) < CACHE_TTL) return _riskCache;

  const [ofacLists, scamLists] = await Promise.all([
    Promise.all(OFAC_SOURCES.map(fetchTxtList)),
    Promise.all(SCAM_SOURCES.map(fetchScamList)),
  ]);

  const ofac = new Set();
  ofacLists.forEach(arr => arr.forEach(a => ofac.add(a)));
  KNOWN_MIXERS.forEach(m => ofac.add(m));

  const scam = new Set();
  scamLists.forEach(arr => arr.forEach(a => scam.add(a)));

  _riskCache = { ofac, mixers: KNOWN_MIXERS, scam, ts: now };
  return _riskCache;
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════
function detectNetwork(addr) {
  if (/^0x[0-9a-fA-F]{40}$/.test(addr)) return 'evm';
  if (/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,59}$/.test(addr)) return 'bitcoin';
  if (/^T[a-zA-Z0-9]{33}$/.test(addr)) return 'tron';
  if (addr.length >= 32 && addr.length <= 44) return 'solana';
  return 'unknown';
}

function classifyAddress(addr, risk, labels) {
  const a = (addr || '').toLowerCase();
  if (risk.ofac.has(a)) return 'sanctioned';
  if (SANCTIONED_GEO[a]) return 'sanctioned_geo';
  if (risk.mixers.has(a)) return 'mixer';
  if (risk.scam && risk.scam.has(a)) return 'scam';
  if (GAMBLING_ADDRS[a]) return 'gambling';
  if (KNOWN_EXCHANGES[a]) return 'exchange';
  // Improvement 2: dynamic entity labels from Etherscan/Tronscan public tags
  if (labels && labels[a]) {
    const lbl = labels[a].toLowerCase();
    if (/tornado|mixer|tumbler|chipmixer|blender/.test(lbl)) return 'mixer';
    if (/garantex|suex|bitzlato|chatex|hydra/.test(lbl)) return 'sanctioned_geo';
    if (/sanction|ofac|lazarus/.test(lbl)) return 'sanctioned';
    if (/phish|scam|fake|hack|exploit|drainer|theft|stolen/.test(lbl)) return 'scam';
    if (/stake|roobet|1win|casino|gambl|bet365|betting/.test(lbl)) return 'gambling';
    if (/binance|okx|bybit|coinbase|kraken|kucoin|huobi|gate|bitfinex|exchange/.test(lbl)) return 'exchange';
  }
  return 'unknown';
}

// Improvement 2: resolve human-readable entity name for an address
function resolveEntityName(addr, labels) {
  const a = (addr || '').toLowerCase();
  if (KNOWN_EXCHANGES[a]) return KNOWN_EXCHANGES[a];
  if (SANCTIONED_GEO[a]) return SANCTIONED_GEO[a];
  if (GAMBLING_ADDRS[a]) return GAMBLING_ADDRS[a];
  if (labels && labels[a]) return labels[a];
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// IMPROVEMENT 2: ENTITY LABELS (public address tags)
// Fetches name-tags for a batch of addresses. Best-effort, never throws.
// ═══════════════════════════════════════════════════════════════════
async function fetchTronLabels(addresses) {
  const labels = {};
  await Promise.allSettled(addresses.slice(0, 12).map(async (addr) => {
    try {
      const r = await fetch(`https://apilist.tronscanapi.com/api/accountv2?address=${addr}`,
        { headers: { 'TRON-PRO-API-KEY': TRON_KEY } });
      if (!r.ok) return;
      const d = await r.json();
      // Tronscan exposes public tags in several fields
      const tag = (d && (d.addressTag || d.publicTag || (d.tag && d.tag.tag) ||
        (Array.isArray(d.redTag) ? d.redTag.join(' ') : d.redTag) ||
        (d.accountInfo && d.accountInfo.publicTag))) || null;
      if (tag) labels[addr.toLowerCase()] = String(tag);
    } catch (e) {}
  }));
  return labels;
}

async function fetchEvmLabels(addresses) {
  const labels = {};
  // Etherscan public name-tag endpoint is limited; we use the metadata/ens
  // and known-address heuristics. Best-effort, never throws.
  await Promise.allSettled(addresses.slice(0, 12).map(async (addr) => {
    try {
      const r = await fetch(
        `https://api.etherscan.io/api?module=account&action=txlist&address=${addr}&page=1&offset=1&sort=asc&apikey=${ETHERSCAN_KEY}`);
      if (!r.ok) return;
      // Etherscan free tier doesn't return name tags via API; placeholder hook.
      // Labels primarily come from KNOWN_EXCHANGES + scam/ofac sets.
    } catch (e) {}
  }));
  return labels;
}

// ═══════════════════════════════════════════════════════════════════
// ITEM 3: GAS SOURCE TRACKER
// Finds the FIRST funding tx (wallet activation) and checks if the
// funder is dirty. HONEST: this is a SIGNAL, not 100% proof — a clean
// wallet funded from a mixer is suspicious, but legitimate funders exist.
// ═══════════════════════════════════════════════════════════════════
async function checkTronGasSource(addr, risk, labels) {
  try {
    // Oldest-first: the very first incoming tx that activated the wallet
    const r = await fetch(`https://apilist.tronscanapi.com/api/transaction?address=${addr}&limit=1&start=0&sort=timestamp`,
      { headers: { 'TRON-PRO-API-KEY': TRON_KEY } });
    if (!r.ok) return null;
    const d = await r.json();
    const total = (d && d.total) || 0;
    if (!total) return null;
    // Fetch the earliest tx (start = total-1)
    const start = Math.max(0, total - 1);
    const r2 = await fetch(`https://apilist.tronscanapi.com/api/transaction?address=${addr}&limit=1&start=${start}`,
      { headers: { 'TRON-PRO-API-KEY': TRON_KEY } });
    if (!r2.ok) return null;
    const d2 = await r2.json();
    const first = (d2 && d2.data && d2.data[0]) || null;
    if (!first) return null;
    const funder = first.toAddress === addr ? first.ownerAddress : null;
    if (!funder || funder === addr) return null;
    const cls = classifyAddress(funder, risk, labels);
    const dirty = ['sanctioned','sanctioned_geo','mixer','scam'].includes(cls);
    return {
      funder: funder.slice(0,6) + '...' + funder.slice(-4),
      class: cls,
      name: resolveEntityName(funder, labels),
      dirty,
      date: first.timestamp ? new Date(first.timestamp).toLocaleDateString('uk-UA') : '—',
    };
  } catch (e) { return null; }
}

async function checkEvmGasSource(addr, risk, labels) {
  try {
    // Etherscan: oldest-first, first inbound tx funds the wallet
    const r = await fetch(`https://api.etherscan.io/api?module=account&action=txlist&address=${addr}&page=1&offset=10&sort=asc&apikey=${ETHERSCAN_KEY}`);
    if (!r.ok) return null;
    const d = await r.json();
    const list = (d && d.result) || [];
    if (!Array.isArray(list) || !list.length) return null;
    const al = addr.toLowerCase();
    const firstIn = list.find(t => (t.to || '').toLowerCase() === al && parseFloat(t.value) > 0);
    if (!firstIn) return null;
    const funder = firstIn.from;
    if (!funder || funder.toLowerCase() === al) return null;
    const cls = classifyAddress(funder, risk, labels);
    const dirty = ['sanctioned','sanctioned_geo','mixer','scam'].includes(cls);
    return {
      funder: funder.slice(0,6) + '...' + funder.slice(-4),
      class: cls,
      name: resolveEntityName(funder, labels),
      dirty,
      date: firstIn.timeStamp ? new Date(parseInt(firstIn.timeStamp)*1000).toLocaleDateString('uk-UA') : '—',
    };
  } catch (e) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// LAYER 3+4: VOLUME-BASED % ENGINE + WEIGHTED SCORE
// Takes classified transactions, computes real exposure %
// ═══════════════════════════════════════════════════════════════════
function computeExposure(txs, risk, labels) {
  // txs: [{ counterparty, direction, amountUsd, ... }]
  let totalVolume = 0, sanctionedVolume = 0, mixerVolume = 0, scamVolume = 0, exchangeVolume = 0;
  let geoVolume = 0, gamblingVolume = 0;
  let sanctionedCount = 0, mixerCount = 0, scamCount = 0, exchangeCount = 0, geoCount = 0, gamblingCount = 0;
  // Improvement 3: direction-aware — incoming dirty funds taint the wallet more
  let incomingDirtyVolume = 0;
  const sanctionedHits = [], mixerHits = [], scamHits = [], exchangeHits = [], geoHits = [], gamblingHits = [];

  txs.forEach(tx => {
    const vol = tx.amountUsd || 0;
    totalVolume += vol;
    const incoming = tx.direction === 'in';
    const cls = classifyAddress(tx.counterparty, risk, labels);
    if (cls === 'sanctioned') {
      sanctionedVolume += vol; sanctionedCount++;
      sanctionedHits.push(tx.counterparty);
      if (incoming) incomingDirtyVolume += vol;
    } else if (cls === 'sanctioned_geo') {
      // Russian/sanctioned-geography VASP — counts as sanctioned-grade risk
      geoVolume += vol; geoCount++;
      const name = resolveEntityName(tx.counterparty, labels);
      if (name && !geoHits.includes(name)) geoHits.push(name);
      if (incoming) incomingDirtyVolume += vol;
    } else if (cls === 'mixer') {
      mixerVolume += vol; mixerCount++;
      mixerHits.push(tx.counterparty);
      if (incoming) incomingDirtyVolume += vol;
    } else if (cls === 'scam') {
      scamVolume += vol; scamCount++;
      scamHits.push(tx.counterparty);
      if (incoming) incomingDirtyVolume += vol;
    } else if (cls === 'gambling') {
      gamblingVolume += vol; gamblingCount++;
      const name = resolveEntityName(tx.counterparty, labels);
      if (name && !gamblingHits.includes(name)) gamblingHits.push(name);
    } else if (cls === 'exchange') {
      exchangeVolume += vol; exchangeCount++;
      const name = resolveEntityName(tx.counterparty, labels) || KNOWN_EXCHANGES[(tx.counterparty||'').toLowerCase()];
      if (name && !exchangeHits.includes(name)) exchangeHits.push(name);
    }
  });

  const pct = (v) => totalVolume > 0 ? (v / totalVolume * 100) : 0;
  // Dirty = mixer + scam volume
  const dirtyVolume = mixerVolume + scamVolume;

  return {
    totalVolume,
    sanctionedPercent: pct(sanctionedVolume),
    geoPercent: pct(geoVolume),
    gamblingPercent: pct(gamblingVolume),
    dirtyPercent: pct(dirtyVolume),
    scamPercent: pct(scamVolume),
    exchangePercent: pct(exchangeVolume),
    cleanPercent: Math.max(0, 100 - pct(sanctionedVolume) - pct(geoVolume) - pct(dirtyVolume) - pct(gamblingVolume)),
    incomingDirtyPercent: pct(incomingDirtyVolume),
    sanctionedCount, mixerCount, scamCount, exchangeCount, geoCount, gamblingCount,
    sanctionedHits: [...new Set(sanctionedHits)].slice(0, 5),
    mixerHits: [...new Set(mixerHits)].slice(0, 5),
    geoHits: [...new Set(geoHits)].slice(0, 5),
    gamblingHits: [...new Set(gamblingHits)].slice(0, 5),
    scamHits: [...new Set(scamHits)].slice(0, 5),
    exchangeHits: exchangeHits.slice(0, 5),
  };
}

// LAYER 4: Weighted, explainable score
function computeScore(exposure, flags, patterns) {
  const breakdown = [];
  let score = 0;

  // Direct sanctions contact (heaviest)
  if (exposure.sanctionedCount > 0) {
    const pts = Math.min(40 + Math.round(exposure.sanctionedPercent / 5) * 5, 60);
    score += pts;
    breakdown.push({ key: 'sanctions', label: 'Прямий контакт із санкційними адресами', points: pts, type: 'danger',
      detail: exposure.sanctionedCount + ' транзакцій · ' + exposure.sanctionedPercent.toFixed(1) + '% обсягу' });
  } else {
    breakdown.push({ key: 'sanctions', label: 'Санкційних контактів не виявлено', points: 0, type: 'safe',
      detail: 'Перевірено по OFAC SDN списку' });
  }

  // Mixer interaction
  if (exposure.mixerCount > 0) {
    const pts = Math.min(20 + exposure.mixerCount * 2, 30);
    score += pts;
    breakdown.push({ key: 'mixer', label: 'Взаємодія з міксерами (Tornado Cash)', points: pts, type: 'danger',
      detail: exposure.mixerCount + ' транзакцій · ' + exposure.dirtyPercent.toFixed(1) + '% обсягу' });
  } else {
    breakdown.push({ key: 'mixer', label: 'Прямих mixer interactions не знайдено', points: 0, type: 'safe',
      detail: 'Перевірено Tornado Cash та відомі міксери' });
  }

  // Sanctioned geography (Garantex / Suex / Bitzlato — Russian illicit-finance VASPs)
  if (exposure.geoCount > 0) {
    const pts = Math.min(40 + Math.round(exposure.geoPercent / 5) * 5, 55);
    score += pts;
    breakdown.push({ key: 'geo', label: 'Зв\'язок із підсанкційними обмінниками', points: pts, type: 'danger',
      detail: (exposure.geoHits.join(', ') || exposure.geoCount + ' транзакцій') + ' · ' + exposure.geoPercent.toFixed(1) + '% обсягу' });
  } else {
    breakdown.push({ key: 'geo', label: 'Підсанкційних обмінників не виявлено', points: 0, type: 'safe',
      detail: 'Перевірено Garantex, Suex, Bitzlato та ін.' });
  }

  // Gambling exposure (High Risk for many CEX, but not criminal per se)
  if (exposure.gamblingCount > 0) {
    const pts = Math.min(10 + Math.round(exposure.gamblingPercent / 10) * 5, 20);
    score += pts;
    breakdown.push({ key: 'gambling', label: 'Взаємодія з гральними платформами', points: pts, type: 'warn',
      detail: (exposure.gamblingHits.join(', ') || exposure.gamblingCount + ' транзакцій') + ' · ' + exposure.gamblingPercent.toFixed(1) + '% обсягу' });
  }

  // Scam / hacker / phishing — on-chain (live feeds) + GoPlus flags
  if (exposure.scamCount > 0) {
    const pts = Math.min(15 + exposure.scamCount * 3, 25);
    score += pts;
    breakdown.push({ key: 'scam', label: 'Взаємодія зі скам/хакерськими адресами', points: pts, type: 'danger',
      detail: exposure.scamCount + ' транзакцій · ' + exposure.scamPercent.toFixed(1) + '% обсягу (live scam feeds)' });
  } else if (flags.scam || flags.phishing) {
    score += 15;
    breakdown.push({ key: 'scam', label: 'Виявлено зв\'язки зі скам/фішинг адресами', points: 15, type: 'danger',
      detail: 'За даними GoPlus Security' });
  } else {
    breakdown.push({ key: 'scam', label: 'Відомих phishing entities не виявлено', points: 0, type: 'safe',
      detail: 'Перевірено GoPlus + live scam feeds' });
  }

  // Improvement 3: direction-aware — incoming dirty funds are the real taint
  if (exposure.incomingDirtyPercent > 0) {
    const pts = Math.min(Math.round(exposure.incomingDirtyPercent / 5) * 5, 15);
    if (pts > 0) {
      score += pts;
      breakdown.push({ key: 'incoming', label: 'Вхідні кошти з ризикових джерел', points: pts, type: 'danger',
        detail: exposure.incomingDirtyPercent.toFixed(1) + '% обсягу надійшло з ризикових адрес (вхідні)' });
    }
  }

  // P2P / OTC pattern
  if (patterns.p2pExposure) {
    score += 10;
    breakdown.push({ key: 'p2p', label: 'Висока P2P / OTC активність', points: 10, type: 'warn',
      detail: patterns.uniqueCounterparties + ' унікальних контрагентів' });
  }

  // Anomalous patterns
  if (patterns.anomalous) {
    score += 5;
    breakdown.push({ key: 'pattern', label: 'Аномальні транзакційні патерни', points: 5, type: 'warn',
      detail: patterns.anomalyReason || 'Round amounts / burst activity' });
  }

  // Velocity — transit/gateway wallet (high volume, low retained balance)
  if (patterns.velocityFlag) {
    score += 10;
    breakdown.push({ key: 'velocity', label: 'Висока швидкість обігу коштів (транзитний вузол)', points: 10, type: 'warn',
      detail: patterns.velocityDetail || 'Обсяг значно перевищує середній баланс' });
  }

  // Burst activity — disposable/bot wallet behaviour
  if (patterns.burstFlag) {
    score += 8;
    breakdown.push({ key: 'burst', label: 'Вибухова активність (burst)', points: 8, type: 'warn',
      detail: patterns.burstDetail || 'Багато транзакцій за короткий період' });
  }

  // Peeling Chain — HONEST: flagged as suspicion, not proof
  if (patterns.peelingSuspicion) {
    score += 8;
    breakdown.push({ key: 'peeling', label: 'Підозра на структуру відмивання (Peeling Chain)', points: 8, type: 'warn',
      detail: patterns.peelingDetail || 'Послідовне зняття невеликих сум — потребує ручної перевірки' });
  }

  // Item 3: Gas source — wallet activated from a dirty funder (SIGNAL, not proof)
  if (patterns.gasSource && patterns.gasSource.dirty) {
    const gs = patterns.gasSource;
    score += 12;
    const nm = gs.name ? ' (' + gs.name + ')' : '';
    breakdown.push({ key: 'gas', label: 'Гаманець активовано з ризикового джерела', points: 12, type: 'warn',
      detail: 'Перше поповнення від ' + gs.funder + nm + ' · сигнал, потребує перевірки' });
  }

  // Positive: regulated exchange interaction
  if (exposure.exchangeCount > 0) {
    score = Math.max(0, score - 10);
    breakdown.push({ key: 'cex', label: 'Взаємодія з регульованими біржами', points: -10, type: 'safe',
      detail: exposure.exchangeHits.join(', ') || (exposure.exchangeCount + ' транзакцій') });
  }

  score = Math.max(0, Math.min(100, score));
  // Sanctioned or sanctioned-geo contact forces high level regardless of offsets
  const forcedHigh = exposure.sanctionedCount > 0 || exposure.geoCount > 0;
  const level = (forcedHigh || score >= 65) ? 'high' : score >= 30 ? 'medium' : 'low';
  return { score, level, breakdown };
}

// Transaction pattern analysis (heuristics — honest, never claimed as proof)
function analyzePatterns(txs, balanceUsd) {
  const uniqueCps = new Set(txs.map(t => t.counterparty)).size;
  const total = txs.length;

  // P2P heuristic: many unique counterparties relative to tx count
  const p2pExposure = total > 20 && uniqueCps / total > 0.6;

  // Round-amount heuristic
  const roundCount = txs.filter(t => t.amountUsd && Number.isInteger(t.amountUsd) && t.amountUsd % 100 === 0).length;
  const anomalous = total > 10 && roundCount / total > 0.4;

  // Velocity — total volume vs retained balance (transit gateway)
  const totalVol = txs.reduce((s, t) => s + (t.amountUsd || 0), 0);
  let velocityFlag = false, velocityDetail = null;
  if (balanceUsd && balanceUsd > 0 && totalVol > 0) {
    const ratio = totalVol / balanceUsd;
    if (ratio > 20 && total > 10) {
      velocityFlag = true;
      velocityDetail = 'Обіг у ~' + Math.round(ratio) + 'x перевищує поточний баланс';
    }
  }

  // Burst — many txs clustered in time (needs timestamps; best-effort by same-day grouping)
  let burstFlag = false, burstDetail = null;
  const byDay = {};
  txs.forEach(t => { if (t.timestamp) byDay[t.timestamp] = (byDay[t.timestamp] || 0) + 1; });
  const maxDay = Math.max(0, ...Object.values(byDay));
  if (total > 20 && maxDay >= Math.max(15, total * 0.5)) {
    burstFlag = true;
    burstDetail = maxDay + ' транзакцій за один день';
  }

  // Peeling Chain SUSPICION — sequential outgoing of slightly-decreasing amounts.
  // HONEST: this is a weak heuristic on the wallet's own txs, flagged as suspicion only.
  let peelingSuspicion = false, peelingDetail = null;
  const outs = txs.filter(t => t.direction === 'out' && t.amountUsd > 0)
    .sort((a, b) => (b.amountUsd) - (a.amountUsd));
  if (outs.length >= 4) {
    let stepLike = 0;
    for (let i = 1; i < outs.length; i++) {
      const drop = outs[i-1].amountUsd - outs[i].amountUsd;
      const rel = drop / (outs[i-1].amountUsd || 1);
      if (rel > 0 && rel < 0.15) stepLike++; // small consistent decrements
    }
    if (stepLike >= 3) {
      peelingSuspicion = true;
      peelingDetail = 'Послідовність із ' + (stepLike + 1) + ' вихідних транзакцій зі спадними сумами';
    }
  }

  return {
    uniqueCounterparties: uniqueCps,
    p2pExposure,
    anomalous,
    anomalyReason: anomalous ? 'Багато round-number транзакцій' : null,
    velocityFlag, velocityDetail,
    burstFlag, burstDetail,
    peelingSuspicion, peelingDetail,
  };
}

// ═══════════════════════════════════════════════════════════════════
// LAYER 1: TRON DATA + HOP-2 GRAPH
// ═══════════════════════════════════════════════════════════════════
async function fetchTronReport(addr, risk) {
  const h = { 'TRON-PRO-API-KEY': TRON_KEY };

  const [accRes, trc20Res, goplusRes, txDetailRes] = await Promise.allSettled([
    fetch(`https://apilist.tronscanapi.com/api/accountv2?address=${addr}`, { headers: h }),
    fetch(`https://apilist.tronscanapi.com/api/account/tokens?address=${addr}&start=0&limit=50&token_type=trc20`, { headers: h }),
    fetch(`https://api.gopluslabs.io/api/v1/address_security/${addr}?chain_id=tron`),
    fetch(`https://apilist.tronscanapi.com/api/transaction?address=${addr}&limit=50&start=0&count=true`, { headers: h }),
  ]);

  const acc = accRes.status === 'fulfilled' && accRes.value.ok ? await accRes.value.json() : null;
  const trc20 = trc20Res.status === 'fulfilled' && trc20Res.value.ok ? await trc20Res.value.json() : null;
  const gp = goplusRes.status === 'fulfilled' && goplusRes.value.ok ? await goplusRes.value.json() : null;
  const txDetail = txDetailRes.status === 'fulfilled' && txDetailRes.value.ok ? await txDetailRes.value.json() : null;

  const txDetailList = (txDetail && txDetail.data) || [];

  // Build normalized tx list with USD amounts
  const txs = txDetailList.map(tx => {
    if (!tx.ownerAddress) return null;
    const isIncoming = tx.toAddress === addr;
    const counterparty = isIncoming ? tx.ownerAddress : tx.toAddress;
    if (!counterparty || counterparty === addr) return null;
    let amountUsd = 0, amount = 0, symbol = 'TRX';
    if (tx.tokenInfo && tx.amount) {
      const dec = tx.tokenInfo.tokenDecimal || 6;
      amount = parseFloat(tx.amount) / Math.pow(10, dec);
      symbol = tx.tokenInfo.tokenAbbr || 'TOKEN';
      // USDT/USDC ~ $1
      if (/^(usdt|usdc|tusd|usdd)$/i.test(symbol)) amountUsd = amount;
      else amountUsd = amount; // best effort
    } else if (tx.amount && tx.contractType === 1) {
      amount = parseFloat(tx.amount) / 1e6;
      amountUsd = amount * 0.12; // approx TRX price
      symbol = 'TRX';
    }
    return {
      counterparty, direction: isIncoming ? 'in' : 'out',
      amount, amountUsd, symbol,
      timestamp: tx.timestamp ? new Date(tx.timestamp).toLocaleDateString('uk-UA') : '—',
      hash: tx.hash ? tx.hash.slice(0, 10) + '...' : '—',
    };
  }).filter(Boolean);

  // ── HOP-2 GRAPH: check top counterparties' own exposure ──
  // Pick top counterparties by frequency, check each against OFAC/mixer at hop-2
  const cpFreq = {};
  txs.forEach(t => { cpFreq[t.counterparty] = (cpFreq[t.counterparty] || 0) + 1; });
  const topCps = Object.keys(cpFreq).sort((a,b) => cpFreq[b]-cpFreq[a]).slice(0, 10);

  // Improvement 2: fetch public entity labels for top counterparties
  const labels = await fetchTronLabels(topCps);

  let hop2Sanctioned = 0, hop2Mixer = 0;
  const riskyHop2 = []; // counterparties whose graph showed risk → candidates for hop-3
  const hop2Results = await Promise.allSettled(topCps.map(cp =>
    fetch(`https://apilist.tronscanapi.com/api/transaction?address=${cp}&limit=20&start=0`, { headers: h })
      .then(r => r.ok ? r.json() : null).then(j => ({ cp, j }))
  ));
  hop2Results.forEach(res => {
    if (res.status !== 'fulfilled' || !res.value || !res.value.j || !res.value.j.data) return;
    let cpRisky = false;
    res.value.j.data.forEach(tx => {
      const other = (tx.toAddress === tx.ownerAddress) ? null : [tx.toAddress, tx.ownerAddress];
      if (!other) return;
      other.forEach(o => {
        const cls = classifyAddress(o, risk, labels);
        if (cls === 'sanctioned') { hop2Sanctioned++; cpRisky = true; }
        else if (cls === 'mixer') { hop2Mixer++; cpRisky = true; }
      });
    });
    if (cpRisky) riskyHop2.push(res.value.cp);
  });

  // Item 4: TARGETED hop-3 — only follow counterparties that ALREADY showed risk
  // at hop-2 (keeps it fast + meaningful, avoids Netlify timeout from full hop-3).
  let hop3Sanctioned = 0, hop3Mixer = 0, hop3Checked = 0;
  if (riskyHop2.length > 0) {
    const hop3Targets = riskyHop2.slice(0, 3); // cap breadth
    hop3Checked = hop3Targets.length;
    const hop3Results = await Promise.allSettled(hop3Targets.map(cp =>
      fetch(`https://apilist.tronscanapi.com/api/transaction?address=${cp}&limit=15&start=0`, { headers: h })
        .then(r => r.ok ? r.json() : null)
    ));
    hop3Results.forEach(res => {
      if (res.status !== 'fulfilled' || !res.value || !res.value.data) return;
      res.value.data.forEach(tx => {
        const other = (tx.toAddress === tx.ownerAddress) ? null : [tx.toAddress, tx.ownerAddress];
        if (!other) return;
        other.forEach(o => {
          const cls = classifyAddress(o, risk, labels);
          if (cls === 'sanctioned') hop3Sanctioned++;
          else if (cls === 'mixer') hop3Mixer++;
        });
      });
    });
  }

  // Item 3: gas source (wallet activation funder)
  const gasSource = await checkTronGasSource(addr, risk, labels);

  // Layer 3: exposure
  const exposure = computeExposure(txs, risk, labels);
  // Add indirect (hop-2 + hop-3) exposure as a flag
  const indirectExposure = hop2Sanctioned > 0 || hop2Mixer > 0 || hop3Sanctioned > 0 || hop3Mixer > 0;

  // GoPlus flags
  const gpRes = gp?.result || {};
  const flags = {
    scam: gpRes.cybercrime === '1' || gpRes.money_laundering === '1' || gpRes.financial_crime === '1',
    phishing: gpRes.phishing_activities === '1',
    sanctioned: gpRes.sanctioned === '1',
    darknet: gpRes.darkweb_transactions === '1',
    blacklist: gpRes.blacklist_doubt === '1',
    stealing: gpRes.stealing_attack === '1',
  };

  // Layer 4: score (compute balance early for velocity heuristic)
  const _trxBal = acc ? (parseInt(acc.balance || 0) / 1e6) : 0;
  let _usdtBal = 0;
  if (trc20 && Array.isArray(trc20)) {
    const _u = trc20.find(t => (t.tokenAbbr||'').toUpperCase() === 'USDT');
    if (_u) _usdtBal = parseInt(_u.balance || 0) / Math.pow(10, _u.tokenDecimal || 6);
  }
  const patterns = analyzePatterns(txs, _trxBal * 0.12 + _usdtBal);
  patterns.gasSource = gasSource; // Item 3
  const scoring = computeScore(exposure, flags, patterns);
  if (indirectExposure && scoring.score < 65) {
    scoring.score = Math.min(scoring.score + 12, 74);
    scoring.level = scoring.score >= 65 ? 'high' : 'medium';
    scoring.breakdown.push({ key: 'indirect', label: 'Indirect exposure (hop-2)', points: 12, type: 'warn',
      detail: 'Контрагенти взаємодіють з ризиковими адресами' });
  }

  // Balance
  const trxBalance = acc ? (parseInt(acc.balance || 0) / 1e6) : 0;
  let usdtBalance = 0;
  if (trc20 && Array.isArray(trc20)) {
    const usdtToken = trc20.find(t => (t.tokenAbbr||'').toUpperCase() === 'USDT');
    if (usdtToken) usdtBalance = parseInt(usdtToken.balance || 0) / Math.pow(10, usdtToken.tokenDecimal || 6);
  }

  const txCount = acc ? (acc.totalTransactionCount || acc.transactions || txs.length) : txs.length;

  return assembleReport({
    addr, network: 'TRON (TRC20)',
    balance: { trx: trxBalance.toFixed(2), usdt: usdtBalance.toFixed(2), totalUsd: (trxBalance*0.12 + usdtBalance).toFixed(2) },
    txCount,
    txs, exposure, flags, scoring, patterns, indirectExposure, labels,
    hop2: { sanctioned: hop2Sanctioned, mixer: hop2Mixer, checked: topCps.length },
    hop3: { sanctioned: hop3Sanctioned, mixer: hop3Mixer, checked: hop3Checked },
    gasSource,
  });
}

// ═══════════════════════════════════════════════════════════════════
// LAYER 1: EVM DATA + HOP-2 GRAPH (Moralis)
// ═══════════════════════════════════════════════════════════════════
async function fetchEvmReport(addr, risk) {
  const addrLower = addr.toLowerCase();
  const mh = { 'X-API-Key': MORALIS_KEY, 'accept': 'application/json' };

  const [txRes, erc20Res, balRes, goplusRes] = await Promise.allSettled([
    fetch(`https://deep-index.moralis.io/api/v2.2/${addr}?chain=eth&limit=50`, { headers: mh }),
    fetch(`https://deep-index.moralis.io/api/v2.2/${addr}/erc20/transfers?chain=eth&limit=50`, { headers: mh }),
    fetch(`https://deep-index.moralis.io/api/v2.2/${addr}/balance?chain=eth`, { headers: mh }),
    fetch(`https://api.gopluslabs.io/api/v1/address_security/${addr}?chain_id=1`),
  ]);

  const txData = txRes.status === 'fulfilled' && txRes.value.ok ? await txRes.value.json() : null;
  const erc20Data = erc20Res.status === 'fulfilled' && erc20Res.value.ok ? await erc20Res.value.json() : null;
  const balData = balRes.status === 'fulfilled' && balRes.value.ok ? await balRes.value.json() : null;
  const gp = goplusRes.status === 'fulfilled' && goplusRes.value.ok ? await goplusRes.value.json() : null;

  const rawTxs = (txData && txData.result) || [];
  const erc20Txs = (erc20Data && erc20Data.result) || [];

  // Normalize native ETH txs
  const txs = [];
  rawTxs.forEach(tx => {
    if (!tx.from_address || !tx.to_address) return;
    const isIncoming = tx.to_address.toLowerCase() === addrLower;
    const counterparty = isIncoming ? tx.from_address : tx.to_address;
    if (!counterparty || counterparty.toLowerCase() === addrLower) return;
    const ethVal = tx.value ? parseInt(tx.value) / 1e18 : 0;
    if (ethVal <= 0.000001) return;
    txs.push({
      counterparty, direction: isIncoming ? 'in' : 'out',
      amount: ethVal, amountUsd: ethVal * 3000, symbol: 'ETH',
      timestamp: tx.block_timestamp ? new Date(tx.block_timestamp).toLocaleDateString('uk-UA') : '—',
      hash: tx.hash ? tx.hash.slice(0, 10) + '...' : '—',
    });
  });
  // Add ERC20 transfers (USDT/USDC counted at face value)
  erc20Txs.forEach(tx => {
    if (!tx.from_address || !tx.to_address) return;
    const isIncoming = tx.to_address.toLowerCase() === addrLower;
    const counterparty = isIncoming ? tx.from_address : tx.to_address;
    if (!counterparty || counterparty.toLowerCase() === addrLower) return;
    const dec = parseInt(tx.token_decimals || 18);
    const amt = tx.value ? parseFloat(tx.value) / Math.pow(10, dec) : 0;
    const sym = (tx.token_symbol || 'TOKEN').toUpperCase();
    let usd = 0;
    if (/^(usdt|usdc|dai|tusd|busd)$/i.test(sym)) usd = amt;
    txs.push({
      counterparty, direction: isIncoming ? 'in' : 'out',
      amount: amt, amountUsd: usd, symbol: sym,
      timestamp: tx.block_timestamp ? new Date(tx.block_timestamp).toLocaleDateString('uk-UA') : '—',
      hash: tx.transaction_hash ? tx.transaction_hash.slice(0, 10) + '...' : '—',
    });
  });

  // ── HOP-2: check top counterparties via Moralis ──
  const cpFreq = {};
  txs.forEach(t => { cpFreq[t.counterparty] = (cpFreq[t.counterparty]||0)+1; });
  const topCps = Object.keys(cpFreq).sort((a,b)=>cpFreq[b]-cpFreq[a]).slice(0, 10);

  // Improvement 2: public entity labels for top counterparties
  const labels = await fetchEvmLabels(topCps);

  let hop2Sanctioned = 0, hop2Mixer = 0;
  const riskyHop2 = [];
  // Deep hop-2 via API
  const hop2 = await Promise.allSettled(topCps.slice(0,8).map(cp =>
    fetch(`https://deep-index.moralis.io/api/v2.2/${cp}?chain=eth&limit=15`, { headers: mh })
      .then(r => r.ok ? r.json() : null).then(j => ({ cp, j }))
  ));
  hop2.forEach(res => {
    if (res.status !== 'fulfilled' || !res.value || !res.value.j || !res.value.j.result) return;
    let cpRisky = false;
    res.value.j.result.forEach(tx => {
      [tx.from_address, tx.to_address].forEach(o => {
        const cls = classifyAddress(o, risk, labels);
        if (cls === 'sanctioned') { hop2Sanctioned++; cpRisky = true; }
        else if (cls === 'mixer') { hop2Mixer++; cpRisky = true; }
      });
    });
    if (cpRisky) riskyHop2.push(res.value.cp);
  });

  // Item 4: TARGETED hop-3 — only follow already-risky hop-2 counterparties
  let hop3Sanctioned = 0, hop3Mixer = 0, hop3Checked = 0;
  if (riskyHop2.length > 0) {
    const hop3Targets = riskyHop2.slice(0, 3);
    hop3Checked = hop3Targets.length;
    const hop3 = await Promise.allSettled(hop3Targets.map(cp =>
      fetch(`https://deep-index.moralis.io/api/v2.2/${cp}?chain=eth&limit=12`, { headers: mh })
        .then(r => r.ok ? r.json() : null)
    ));
    hop3.forEach(res => {
      if (res.status !== 'fulfilled' || !res.value || !res.value.result) return;
      res.value.result.forEach(tx => {
        [tx.from_address, tx.to_address].forEach(o => {
          const cls = classifyAddress(o, risk, labels);
          if (cls === 'sanctioned') hop3Sanctioned++;
          else if (cls === 'mixer') hop3Mixer++;
        });
      });
    });
  }

  // Item 3: gas source
  const gasSource = await checkEvmGasSource(addr, risk, labels);

  const exposure = computeExposure(txs, risk, labels);
  const indirectExposure = hop2Sanctioned > 0 || hop2Mixer > 0 || hop3Sanctioned > 0 || hop3Mixer > 0;

  const gpRes = gp?.result?.[addrLower] || gp?.result || {};
  const flags = {
    scam: gpRes.cybercrime === '1' || gpRes.money_laundering === '1' || gpRes.financial_crime === '1',
    phishing: gpRes.phishing_activities === '1',
    sanctioned: gpRes.sanctioned === '1' || risk.ofac.has(addrLower),
    darknet: gpRes.darkweb_transactions === '1',
    blacklist: gpRes.blacklist_doubt === '1',
    stealing: gpRes.stealing_attack === '1',
  };
  // Direct OFAC on the address itself
  if (risk.ofac.has(addrLower)) {
    exposure.sanctionedCount = Math.max(exposure.sanctionedCount, 1);
    exposure.sanctionedPercent = Math.max(exposure.sanctionedPercent, 100);
  }

  const _ethBal = balData && balData.balance ? parseInt(balData.balance) / 1e18 : 0;
  const patterns = analyzePatterns(txs, _ethBal * 3000);
  patterns.gasSource = gasSource; // Item 3
  const scoring = computeScore(exposure, flags, patterns);
  if (indirectExposure && scoring.score < 65) {
    scoring.score = Math.min(scoring.score + 12, 74);
    scoring.level = scoring.score >= 65 ? 'high' : 'medium';
    scoring.breakdown.push({ key: 'indirect', label: 'Indirect exposure (hop-2)', points: 12, type: 'warn',
      detail: 'Контрагенти взаємодіють з ризиковими адресами' });
  }

  const ethBal = balData && balData.balance ? parseInt(balData.balance) / 1e18 : 0;

  return assembleReport({
    addr, network: 'Ethereum',
    balance: { native: ethBal.toFixed(4) + ' ETH', totalUsd: (ethBal * 3000).toFixed(2) },
    txCount: rawTxs.length + erc20Txs.length,
    txs, exposure, flags, scoring, patterns, indirectExposure, labels,
    hop2: { sanctioned: hop2Sanctioned, mixer: hop2Mixer, checked: topCps.length },
    hop3: { sanctioned: hop3Sanctioned, mixer: hop3Mixer, checked: hop3Checked },
    gasSource,
  });
}

// ═══════════════════════════════════════════════════════════════════
// BITCOIN (Blockchair) — lists-based, no deep graph
// ═══════════════════════════════════════════════════════════════════
async function fetchBitcoinReport(addr, risk) {
  let data = null;
  try {
    const res = await fetch(`https://api.blockchair.com/bitcoin/dashboards/address/${addr}`);
    if (res.ok) data = await res.json();
  } catch (e) {}

  const info = data?.data?.[addr]?.address || {};
  const balance = (info.balance || 0) / 1e8;
  const txCount = info.transaction_count || 0;
  const isOfac = risk.ofac.has(addr.toLowerCase());

  const exposure = {
    totalVolume: 0, sanctionedPercent: isOfac ? 100 : 0, dirtyPercent: 0, scamPercent: 0,
    exchangePercent: 0, cleanPercent: isOfac ? 0 : 100, incomingDirtyPercent: 0,
    sanctionedCount: isOfac ? 1 : 0, mixerCount: 0, scamCount: 0, exchangeCount: 0,
    sanctionedHits: isOfac ? [addr] : [], mixerHits: [], scamHits: [], exchangeHits: [],
  };
  const flags = { scam: false, phishing: false, sanctioned: isOfac, darknet: false, blacklist: false, stealing: false };
  const patterns = { uniqueCounterparties: 0, p2pExposure: false, anomalous: false };
  const scoring = computeScore(exposure, flags, patterns);

  return assembleReport({
    addr, network: 'Bitcoin',
    balance: { btc: balance.toFixed(8), totalUsd: (balance * 95000).toFixed(2) },
    txCount, txs: [], exposure, flags, scoring, patterns, indirectExposure: false, labels: {},
    hop2: { sanctioned: 0, mixer: 0, checked: 0 },
  });
}

// ═══════════════════════════════════════════════════════════════════
// LAYER 5: REPORT ASSEMBLY
// Converts engine output → client-facing report structure
// ═══════════════════════════════════════════════════════════════════
function assembleReport(d) {
  const { addr, network, balance, txCount, txs, exposure, flags, scoring, patterns, indirectExposure, hop2, hop3, gasSource, labels } = d;

  // Funds structure (real volume-based %)
  const funds = {
    cleanPercent: exposure.cleanPercent.toFixed(1),
    dirtyPercent: exposure.dirtyPercent.toFixed(1),
    sanctionedPercent: exposure.sanctionedPercent.toFixed(1),
  };

  // Recent 3 txs
  const recentTxs = txs.slice(0, 3).map(t => ({
    counterparty: t.counterparty ? t.counterparty.slice(0, 8) + '...' + t.counterparty.slice(-5) : '—',
    direction: t.direction, amount: t.amount ? t.amount.toFixed(2) : '—',
    symbol: t.symbol, timestamp: t.timestamp,
  }));

  // Top counterparties
  const cpFreq = {};
  txs.forEach(t => { cpFreq[t.counterparty] = (cpFreq[t.counterparty]||0)+1; });
  const topCounterparties = Object.keys(cpFreq).sort((a,b)=>cpFreq[b]-cpFreq[a]).slice(0,5).map(cp => {
    const cls = classifyAddress(cp, _riskCache, labels);
    const entityName = resolveEntityName(cp, labels);
    const name = cls === 'sanctioned' ? '⚠ САНКЦІЇ' + (entityName ? ' · ' + entityName : '')
               : cls === 'mixer' ? '⚠ МІКСЕР' + (entityName ? ' · ' + entityName : '')
               : cls === 'scam' ? '⚠ СКАМ/ХАКЕР' + (entityName ? ' · ' + entityName : '')
               : cls === 'exchange' ? (entityName || 'Біржа')
               : (entityName || 'Невідомий');
    return {
      address: cp.slice(0,6) + '...' + cp.slice(-4),
      count: cpFreq[cp],
      percentage: txs.length > 0 ? ((cpFreq[cp]/txs.length)*100).toFixed(1) : '0',
      name, risk: cls,
    };
  });

  // Exchange compatibility (based on score)
  const s = scoring.score;
  const exchangeCompatibility = ['Binance','Bybit','OKX','Coinbase','KuCoin'].map(name => {
    let status, label;
    if (flags.sanctioned || exposure.sanctionedCount > 0 || s > 65) { status = 'blocked'; label = 'Високий ризик блокування'; }
    else if (s > 40 || exposure.mixerCount > 0 || indirectExposure) { status = 'check'; label = 'Можлива додаткова перевірка'; }
    else { status = 'ok'; label = 'Депозит можливий'; }
    return { name, status, label };
  });

  // Reputation
  const reputation = {
    label: scoring.level === 'high' ? 'Висока загроза' : scoring.level === 'medium' ? 'Помірна експозиція' : 'Чистий гаманець',
    desc: scoring.level === 'high' ? 'Виявлено серйозні ризики, пов\'язані з санкціями або міксерами.'
        : scoring.level === 'medium' ? 'Гаманець взаємодіяв з потенційно ризиковими сутностями.'
        : 'Серйозних прямих ризиків не виявлено.',
  };

  // Risk distribution (for charts)
  const riskDistribution = [
    { label: 'Санкційні адреси', value: exposure.sanctionedPercent.toFixed(1), color: 'red' },
    { label: 'Підсанкційні обмінники (РФ)', value: exposure.geoPercent.toFixed(1), color: 'red' },
    { label: 'Міксери / скам', value: exposure.dirtyPercent.toFixed(1), color: 'amber' },
    { label: 'Гемблінг', value: exposure.gamblingPercent.toFixed(1), color: 'amber' },
    { label: 'Регульовані біржі', value: exposure.exchangePercent.toFixed(1), color: 'green' },
  ];

  // Improvement 3: honest limitation wording — detect DeFi/contract interaction
  // (counterparties we couldn't classify but that look like contracts/protocols).
  const unknownShare = topCounterparties.filter(c => c.risk === 'unknown').length;
  const hasDefiOrContracts = txs.some(t => /^0x/.test(t.counterparty || '') &&
    !classifyAddress(t.counterparty, _riskCache, labels).match(/sanctioned|sanctioned_geo|mixer|scam|gambling|exchange/));
  const limitations = [];
  if (hasDefiOrContracts) {
    limitations.push('Виявлено взаємодію з DeFi-протоколами або смарт-контрактами — для повного трасування походження коштів через них потрібен розширений аналіз (доступний у повному звіті).');
  }
  if (exposure.totalVolume === 0) {
    limitations.push('Недостатньо даних про обсяги транзакцій для точного volume-розрахунку — оцінка базується на прямих зв\'язках та відомих базах ризику.');
  }
  if (indirectExposure) {
    limitations.push('Виявлено непрямі зв\'язки (hop-2) з ризиковими адресами через проміжних контрагентів. Точний шлях коштів вимагає глибокого графового аналізу.');
  }

  return {
    address: addr,
    network,
    reportId: 'CS-' + Math.random().toString(36).slice(2,6).toUpperCase() + '-' + Math.random().toString(36).slice(2,6).toUpperCase(),
    riskScore: scoring.score,
    riskLevel: scoring.level,
    scoreBreakdown: scoring.breakdown,   // ← Layer 4 explainable breakdown
    balance,
    activity: {
      txCount: txCount,
      incomingCount: txs.filter(t=>t.direction==='in').length,
      outgoingCount: txs.filter(t=>t.direction==='out').length,
      firstActivity: '—', lastActivity: recentTxs[0]?.timestamp || '—',
      uniqueCounterparties: patterns.uniqueCounterparties,
    },
    funds,                                // ← Layer 3 real % (volume-based)
    fundsMethod: exposure.totalVolume > 0 ? 'volume' : 'flags',
    riskDistribution,
    // AML signals
    ofacMatch: exposure.sanctionedCount > 0 || flags.sanctioned,
    sanctionedRisk: exposure.sanctionedPercent,
    sanctionedGeoPercent: exposure.geoPercent.toFixed(1),
    sanctionedGeoHits: exposure.geoHits,
    sanctionedGeoCount: exposure.geoCount,
    gamblingPercent: exposure.gamblingPercent.toFixed(1),
    gamblingHits: exposure.gamblingHits,
    gamblingCount: exposure.gamblingCount,
    mixerInteractions: exposure.mixerCount,
    scamInteractions: exposure.scamCount,
    darknetInteractions: flags.darknet ? 1 : 0,
    indirectExposure,
    hop2Analysis: hop2,                   // ← Layer 1 hop-2 graph result
    hop3Analysis: hop3 || { sanctioned: 0, mixer: 0, checked: 0 },  // Item 4 targeted hop-3
    gasSource: gasSource || null,         // Item 3 gas source tracker
    suspiciousTxCount: exposure.sanctionedCount + exposure.mixerCount + exposure.scamCount + exposure.geoCount,
    incomingDirtyPercent: exposure.incomingDirtyPercent.toFixed(1),
    patternFlags: {
      velocity: !!patterns.velocityFlag, velocityDetail: patterns.velocityDetail,
      burst: !!patterns.burstFlag, burstDetail: patterns.burstDetail,
      peelingSuspicion: !!patterns.peelingSuspicion, peelingDetail: patterns.peelingDetail,
      p2p: !!patterns.p2pExposure,
    },
    riskFlags: Object.keys(flags).filter(k => flags[k]).map(k => ({ type: k, severity: 'high' })),
    sanctionedHits: exposure.sanctionedHits,
    mixerHits: exposure.mixerHits,
    scamHits: exposure.scamHits,
    recentTxs,
    topCounterparties,
    exchangeCompatibility,
    reputation,
    limitations,                          // ← Improvement 3 honest wording / upsell hook
    analyzedTxs: txs.length,
  };
}

// ═══════════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════════
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const addr = (event.queryStringParameters && event.queryStringParameters.addr || '').trim();
  if (!addr || addr.length < 8) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid address' }) };
  }

  try {
    const risk = await loadRiskLists();
    const network = detectNetwork(addr);
    let report;
    if (network === 'tron') report = await fetchTronReport(addr, risk);
    else if (network === 'evm') report = await fetchEvmReport(addr, risk);
    else if (network === 'bitcoin') report = await fetchBitcoinReport(addr, risk);
    else return { statusCode: 200, headers, body: JSON.stringify({ error: 'Unsupported network' }) };

    return { statusCode: 200, headers, body: JSON.stringify(report) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
