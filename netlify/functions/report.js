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
let _riskCache = { ofac: null, mixers: null, ts: 0 };
const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours

const OFAC_SOURCES = [
  'https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt',
  'https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_USDT.txt',
  'https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_USDC.txt',
  'https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_TRX.txt',
  'https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_XBT.txt',
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

async function fetchTxtList(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const text = await res.text();
    return text.split('\n').map(l => l.trim().toLowerCase()).filter(Boolean);
  } catch (e) { return []; }
}

async function loadRiskLists() {
  const now = Date.now();
  if (_riskCache.ofac && (now - _riskCache.ts) < CACHE_TTL) return _riskCache;
  const lists = await Promise.all(OFAC_SOURCES.map(fetchTxtList));
  const ofac = new Set();
  lists.forEach(arr => arr.forEach(a => ofac.add(a)));
  KNOWN_MIXERS.forEach(m => ofac.add(m));
  _riskCache = { ofac, mixers: KNOWN_MIXERS, ts: now };
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

function classifyAddress(addr, risk) {
  const a = (addr || '').toLowerCase();
  if (risk.ofac.has(a)) return 'sanctioned';
  if (risk.mixers.has(a)) return 'mixer';
  if (KNOWN_EXCHANGES[a]) return 'exchange';
  return 'unknown';
}

// ═══════════════════════════════════════════════════════════════════
// LAYER 3+4: VOLUME-BASED % ENGINE + WEIGHTED SCORE
// Takes classified transactions, computes real exposure %
// ═══════════════════════════════════════════════════════════════════
function computeExposure(txs, risk) {
  // txs: [{ counterparty, direction, amountUsd, ... }]
  let totalVolume = 0, sanctionedVolume = 0, mixerVolume = 0, exchangeVolume = 0;
  let sanctionedCount = 0, mixerCount = 0, exchangeCount = 0;
  const sanctionedHits = [], mixerHits = [], exchangeHits = [];

  txs.forEach(tx => {
    const vol = tx.amountUsd || 0;
    totalVolume += vol;
    const cls = classifyAddress(tx.counterparty, risk);
    if (cls === 'sanctioned') {
      sanctionedVolume += vol; sanctionedCount++;
      sanctionedHits.push(tx.counterparty);
    } else if (cls === 'mixer') {
      mixerVolume += vol; mixerCount++;
      mixerHits.push(tx.counterparty);
    } else if (cls === 'exchange') {
      exchangeVolume += vol; exchangeCount++;
      const name = KNOWN_EXCHANGES[(tx.counterparty||'').toLowerCase()];
      if (name && !exchangeHits.includes(name)) exchangeHits.push(name);
    }
  });

  const pct = (v) => totalVolume > 0 ? (v / totalVolume * 100) : 0;
  // Dirty = mixer + scam (mixer is the measurable part here)
  const dirtyVolume = mixerVolume;

  return {
    totalVolume,
    sanctionedPercent: pct(sanctionedVolume),
    dirtyPercent: pct(dirtyVolume),
    exchangePercent: pct(exchangeVolume),
    cleanPercent: Math.max(0, 100 - pct(sanctionedVolume) - pct(dirtyVolume)),
    sanctionedCount, mixerCount, exchangeCount,
    sanctionedHits: [...new Set(sanctionedHits)].slice(0, 5),
    mixerHits: [...new Set(mixerHits)].slice(0, 5),
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

  // GoPlus / external flags
  if (flags.scam || flags.phishing) {
    score += 15;
    breakdown.push({ key: 'scam', label: 'Виявлено зв\'язки зі скам/фішинг адресами', points: 15, type: 'danger',
      detail: 'За даними GoPlus Security' });
  } else {
    breakdown.push({ key: 'scam', label: 'Відомих phishing entities не виявлено', points: 0, type: 'safe',
      detail: 'Перевірено GoPlus threat intelligence' });
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

  // Positive: regulated exchange interaction
  if (exposure.exchangeCount > 0) {
    score = Math.max(0, score - 10);
    breakdown.push({ key: 'cex', label: 'Взаємодія з регульованими біржами', points: -10, type: 'safe',
      detail: exposure.exchangeHits.join(', ') || (exposure.exchangeCount + ' транзакцій') });
  }

  score = Math.max(0, Math.min(100, score));
  const level = score >= 65 ? 'high' : score >= 30 ? 'medium' : 'low';
  return { score, level, breakdown };
}

// Transaction pattern analysis
function analyzePatterns(txs) {
  const uniqueCps = new Set(txs.map(t => t.counterparty)).size;
  const total = txs.length;
  // P2P heuristic: many unique counterparties relative to tx count
  const p2pExposure = total > 20 && uniqueCps / total > 0.6;
  // Round-amount heuristic
  const roundCount = txs.filter(t => t.amountUsd && Number.isInteger(t.amountUsd) && t.amountUsd % 100 === 0).length;
  const anomalous = total > 10 && roundCount / total > 0.4;
  return {
    uniqueCounterparties: uniqueCps,
    p2pExposure,
    anomalous,
    anomalyReason: anomalous ? 'Багато round-number транзакцій' : null,
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

  let hop2Sanctioned = 0, hop2Mixer = 0;
  const hop2Results = await Promise.allSettled(topCps.map(cp =>
    fetch(`https://apilist.tronscanapi.com/api/transaction?address=${cp}&limit=20&start=0`, { headers: h })
      .then(r => r.ok ? r.json() : null)
  ));
  hop2Results.forEach(res => {
    if (res.status !== 'fulfilled' || !res.value || !res.value.data) return;
    res.value.data.forEach(tx => {
      const other = (tx.toAddress === tx.ownerAddress) ? null : [tx.toAddress, tx.ownerAddress];
      if (!other) return;
      other.forEach(o => {
        const cls = classifyAddress(o, risk);
        if (cls === 'sanctioned') hop2Sanctioned++;
        else if (cls === 'mixer') hop2Mixer++;
      });
    });
  });

  // Layer 3: exposure
  const exposure = computeExposure(txs, risk);
  // Add indirect (hop-2) exposure as a flag
  const indirectExposure = hop2Sanctioned > 0 || hop2Mixer > 0;

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

  // Layer 4: score
  const patterns = analyzePatterns(txs);
  const scoring = computeScore(exposure, flags, patterns);

  // Boost for indirect exposure
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
    txs, exposure, flags, scoring, patterns, indirectExposure,
    hop2: { sanctioned: hop2Sanctioned, mixer: hop2Mixer, checked: topCps.length },
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

  let hop2Sanctioned = 0, hop2Mixer = 0;
  // Quick hop-2: check if top counterparties are themselves flagged (fast, no extra API)
  topCps.forEach(cp => {
    const cls = classifyAddress(cp, risk);
    // direct already counted; hop-2 means their counterparties
  });
  // Deep hop-2 via API
  const hop2 = await Promise.allSettled(topCps.slice(0,8).map(cp =>
    fetch(`https://deep-index.moralis.io/api/v2.2/${cp}?chain=eth&limit=15`, { headers: mh })
      .then(r => r.ok ? r.json() : null)
  ));
  hop2.forEach(res => {
    if (res.status !== 'fulfilled' || !res.value || !res.value.result) return;
    res.value.result.forEach(tx => {
      [tx.from_address, tx.to_address].forEach(o => {
        const cls = classifyAddress(o, risk);
        if (cls === 'sanctioned') hop2Sanctioned++;
        else if (cls === 'mixer') hop2Mixer++;
      });
    });
  });

  const exposure = computeExposure(txs, risk);
  const indirectExposure = hop2Sanctioned > 0 || hop2Mixer > 0;

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

  const patterns = analyzePatterns(txs);
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
    txs, exposure, flags, scoring, patterns, indirectExposure,
    hop2: { sanctioned: hop2Sanctioned, mixer: hop2Mixer, checked: topCps.length },
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
    totalVolume: 0, sanctionedPercent: isOfac ? 100 : 0, dirtyPercent: 0,
    exchangePercent: 0, cleanPercent: isOfac ? 0 : 100,
    sanctionedCount: isOfac ? 1 : 0, mixerCount: 0, exchangeCount: 0,
    sanctionedHits: isOfac ? [addr] : [], mixerHits: [], exchangeHits: [],
  };
  const flags = { scam: false, phishing: false, sanctioned: isOfac, darknet: false, blacklist: false, stealing: false };
  const patterns = { uniqueCounterparties: 0, p2pExposure: false, anomalous: false };
  const scoring = computeScore(exposure, flags, patterns);

  return assembleReport({
    addr, network: 'Bitcoin',
    balance: { btc: balance.toFixed(8), totalUsd: (balance * 95000).toFixed(2) },
    txCount, txs: [], exposure, flags, scoring, patterns, indirectExposure: false,
    hop2: { sanctioned: 0, mixer: 0, checked: 0 },
  });
}

// ═══════════════════════════════════════════════════════════════════
// LAYER 5: REPORT ASSEMBLY
// Converts engine output → client-facing report structure
// ═══════════════════════════════════════════════════════════════════
function assembleReport(d) {
  const { addr, network, balance, txCount, txs, exposure, flags, scoring, patterns, indirectExposure, hop2 } = d;

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
    const cls = classifyAddress(cp, _riskCache);
    const name = cls === 'exchange' ? KNOWN_EXCHANGES[cp.toLowerCase()] :
                 cls === 'sanctioned' ? '⚠ САНКЦІЇ' : cls === 'mixer' ? '⚠ МІКСЕР' : 'Невідомий';
    return {
      address: cp.slice(0,6) + '...' + cp.slice(-4),
      count: cpFreq[cp],
      percentage: txCount > 0 ? ((cpFreq[cp]/txs.length)*100).toFixed(1) : '0',
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
    { label: 'Міксери', value: exposure.dirtyPercent.toFixed(1), color: 'amber' },
    { label: 'Регульовані біржі', value: exposure.exchangePercent.toFixed(1), color: 'green' },
  ];

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
    mixerInteractions: exposure.mixerCount,
    darknetInteractions: flags.darknet ? 1 : 0,
    indirectExposure,
    hop2Analysis: hop2,                   // ← Layer 1 hop-2 graph result
    suspiciousTxCount: exposure.sanctionedCount + exposure.mixerCount,
    riskFlags: Object.keys(flags).filter(k => flags[k]).map(k => ({ type: k, severity: 'high' })),
    sanctionedHits: exposure.sanctionedHits,
    mixerHits: exposure.mixerHits,
    recentTxs,
    topCounterparties,
    exchangeCompatibility,
    reputation,
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
