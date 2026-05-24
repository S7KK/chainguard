const MORALIS_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IjY1NzZhMWRiLWU3NmQtNDY4Yi04ZTZkLTgxMTIwOWY1YWFhYSIsIm9yZ0lkIjoiNTE3MzA0IiwidXNlcklkIjoiNTMyMzY4IiwidHlwZUlkIjoiNjk2MzdlNGUtNDU2Ni00OGI0LWEzMWMtZjA4NmIwMGZlYWI5IiwidHlwZSI6IlBST0pFQ1QiLCJpYXQiOjE3Nzk2NDI5NDAsImV4cCI6NDkzNTQwMjk0MH0.eUv-34sT5cGKIC5_0gJoX_9LdTIvlEx-RybpJ_OCRiU';
const ETHERSCAN_KEY = 'PQBSB54WJ3DR6IIAVEBE3IHHKSRMMHQUJK';

// Known OFAC + Tornado Cash addresses
const OFAC_LIST = [
  '0x8576acc5c05d6ce88f4e49bf65bdf0c62f91353c',
  '0xd882cfc20f52f2599d84b8e8d58c7fb62cfe344b',
  '0x901bb9583b24d97e995513c6778dc6888ab6870e',
  '0x7f367cc41522ce07553e823bf3be79a889debe1b',
  '0x1da5821544e25c636c1417ba96ade4cf6d2f9b5a',
  '0x12d66f87a04a9e220c9d6a5d87e8f396bdd3b51a',
  '0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936',
  '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf',
  '0xa160cdab225685da1d56aa342ad8841c3b53f291',
  '0xfd8610d20aa15b7b2e3be39b396a1bc3516c7144',
  '0xf60dd140cff0706bae9cd734ac3ae76ad9ebc32a',
  '0x22aaa7720ddd5388a3c0a3333430953c68f1849b',
  '0xba214c1c1928a32bffe790263e38b4af9bfcd659',
  '0xb1c8094b234dce6e03f10a5b673c1d8c69739a00',
  '0x19aa5fe80d33a56d56c78e82ea5e50e5d80b4dfe',
  '0x2717c5e28cf931547b621a5dddb772ab6a35b701',
  '0xd21be7248e0197ee08e0c20d4a96debdac3d20af',
  '0x610b717796ad172b316836ac5a01548e5da82e5b',
];

const MIXERS = [
  '0x12d66f87a04a9e220c9d6a5d87e8f396bdd3b51a',
  '0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936',
  '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf',
  '0xa160cdab225685da1d56aa342ad8841c3b53f291',
  '0xfd8610d20aa15b7b2e3be39b396a1bc3516c7144',
];

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const { addr, chain } = event.queryStringParameters || {};
  if (!addr) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No address' }) };

  const chainId = chain || '0x1';
  const mh = { 'X-API-Key': MORALIS_KEY, 'Accept': 'application/json' };
  const base = 'https://deep-index.moralis.io/api/v2.2';
  const addrLower = addr.toLowerCase();

  try {
    // Run all checks in parallel
    const [balRes, txRes, tokRes, nwRes, goplusRes, ensRes] = await Promise.allSettled([
      // 1. Native balance
      fetch(`${base}/${addr}/balance?chain=${chainId}`, { headers: mh }),
      // 2. Transactions
      fetch(`${base}/${addr}/transactions?chain=${chainId}&limit=100`, { headers: mh }),
      // 3. ERC20 tokens
      fetch(`${base}/${addr}/erc20?chain=${chainId}&limit=20`, { headers: mh }),
      // 4. Net worth
      fetch(`${base}/wallets/${addr}/net-worth?chains[]=${chainId}&exclude_spam=true&exclude_unverified_contracts=true`, { headers: mh }),
      // 5. GoPlus Security check
      fetch(`https://api.gopluslabs.io/api/v1/address_security/${addr}?chain_id=1`),
      // 6. ENS name (only for ETH mainnet)
      chainId === '0x1'
        ? fetch(`${base}/resolve/${addr}/reverse?chain=${chainId}`, { headers: mh })
        : Promise.resolve(null),
    ]);

    // Parse balance
    const symbol = chainId === '0x38' ? 'BNB' : chainId === '0x89' ? 'MATIC' : 'ETH';
    let balRaw = '0', balance = '0 ' + symbol;
    if (balRes.status === 'fulfilled' && balRes.value.ok) {
      const bd = await balRes.value.json();
      balRaw = bd.balance ? (parseInt(bd.balance) / 1e18).toFixed(4) : '0';
      balance = balRaw + ' ' + symbol;
    }

    // Parse transactions
    let txList = [], txCount = '0', age = 'N/A', mixerTxCount = 0;
    if (txRes.status === 'fulfilled' && txRes.value.ok) {
      const td = await txRes.value.json();
      txList = td.result || [];
      txCount = td.total ? (td.total > 100 ? '100+' : String(td.total)) : String(txList.length);
      if (txList.length > 0) {
        const oldest = txList[txList.length - 1];
        if (oldest.block_timestamp) {
          age = ((Date.now() - new Date(oldest.block_timestamp).getTime()) / 31536000000).toFixed(1) + ' yrs';
        }
      }
      mixerTxCount = txList.filter(tx =>
        MIXERS.includes((tx.to_address || '').toLowerCase()) ||
        MIXERS.includes((tx.from_address || '').toLowerCase())
      ).length;
    }

    // Parse ERC20 tokens
    let tokens = [], tokenSummary = '';
    const STABLES = ['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDD'];
    if (tokRes.status === 'fulfilled' && tokRes.value.ok) {
      const td = await tokRes.value.json();
      const allTokens = td.result || [];
      tokens = allTokens.filter(t =>
        STABLES.includes(t.symbol) || parseFloat(t.usd_value || 0) > 5
      ).slice(0, 5);
      tokenSummary = tokens.map(t => {
        const amt = (parseInt(t.balance) / Math.pow(10, parseInt(t.decimals || 18))).toFixed(2);
        return amt + ' ' + t.symbol;
      }).join(', ');
    }

    // Parse net worth
    let netWorth = null;
    if (nwRes.status === 'fulfilled' && nwRes.value.ok) {
      const nd = await nwRes.value.json();
      if (nd.total_networth_usd && parseFloat(nd.total_networth_usd) > 0) {
        netWorth = '$' + parseFloat(nd.total_networth_usd).toLocaleString('en-US', { maximumFractionDigits: 2 });
      }
    }

    // Parse GoPlus
    let riskFlags = [], goplusRisk = false;
    if (goplusRes.status === 'fulfilled' && goplusRes.value.ok) {
      const gp = await goplusRes.value.json();
      const r = gp.result && gp.result[addrLower] ? gp.result[addrLower] : {};
      if (r.blacklist_doubt === '1') { riskFlags.push('Blacklist suspect'); goplusRisk = true; }
      if (r.cybercrime === '1') { riskFlags.push('Cybercrime associated'); goplusRisk = true; }
      if (r.money_laundering === '1') { riskFlags.push('Money laundering flagged'); goplusRisk = true; }
      if (r.phishing_activities === '1') { riskFlags.push('Phishing activity'); goplusRisk = true; }
      if (r.darkweb_transactions === '1') { riskFlags.push('Darkweb transactions'); goplusRisk = true; }
      if (r.sanctioned === '1') { riskFlags.push('SANCTIONED ADDRESS'); goplusRisk = true; }
      if (r.stealing_attack === '1') { riskFlags.push('Stealing attack involved'); goplusRisk = true; }
      if (r.fake_token === '1') { riskFlags.push('Fake token associated'); goplusRisk = true; }
    }

    // Parse ENS
    let ensName = null;
    if (ensRes.status === 'fulfilled' && ensRes.value && ensRes.value.ok) {
      const ed = await ensRes.value.json();
      ensName = ed.name || null;
    }

    // OFAC check
    const ofacMatch = OFAC_LIST.includes(addrLower);
    if (ofacMatch) riskFlags.unshift('OFAC SANCTIONS LIST MATCH');

    // Build display balance
    let displayBalance = netWorth || balance;
    if (tokenSummary) displayBalance += ' (' + tokenSummary + ')';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        balance: displayBalance,
        rawBalance: balance,
        netWorth,
        txCount,
        age,
        mixerTxCount,
        tokens,
        tokenSummary,
        ofacMatch,
        goplusRisk,
        riskFlags,
        ensName,
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
