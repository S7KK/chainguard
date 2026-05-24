const MORALIS_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IjY1NzZhMWRiLWU3NmQtNDY4Yi04ZTZkLTgxMTIwOWY1YWFhYSIsIm9yZ0lkIjoiNTE3MzA0IiwidXNlcklkIjoiNTMyMzY4IiwidHlwZUlkIjoiNjk2MzdlNGUtNDU2Ni00OGI0LWEzMWMtZjA4NmIwMGZlYWI5IiwidHlwZSI6IlBST0pFQ1QiLCJpYXQiOjE3Nzk2NDI5NDAsImV4cCI6NDkzNTQwMjk0MH0.eUv-34sT5cGKIC5_0gJoX_9LdTIvlEx-RybpJ_OCRiU';

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
  const h = { 'X-API-Key': MORALIS_KEY, 'Accept': 'application/json' };
  const base = 'https://deep-index.moralis.io/api/v2.2';

  try {
    const [balRes, txRes, tokRes, nwRes] = await Promise.all([
      fetch(`${base}/${addr}/balance?chain=${chainId}`, { headers: h }),
      fetch(`${base}/${addr}/transactions?chain=${chainId}&limit=100`, { headers: h }),
      fetch(`${base}/${addr}/erc20?chain=${chainId}&limit=20`, { headers: h }),
      fetch(`${base}/wallets/${addr}/net-worth?chains[]=${chainId}&exclude_spam=true`, { headers: h }),
    ]);

    const [balData, txData, tokData, nwData] = await Promise.all([
      balRes.json(), txRes.json(), tokRes.json(), nwRes.json(),
    ]);

    const symbol = chainId === '0x38' ? 'BNB' : chainId === '0x89' ? 'MATIC' : 'ETH';
    const balRaw = balData.balance ? (parseInt(balData.balance) / 1e18).toFixed(4) : '0';
    const txList = txData.result || [];
    const tokens = tokData.result || [];
    const netWorth = nwData.total_networth_usd
      ? '$' + parseFloat(nwData.total_networth_usd).toLocaleString('en-US', { maximumFractionDigits: 2 })
      : null;

    // Wallet age
    let age = 'N/A';
    if (txList.length > 0) {
      const oldest = txList[txList.length - 1];
      if (oldest.block_timestamp) {
        age = ((Date.now() - new Date(oldest.block_timestamp).getTime()) / 31536000000).toFixed(1) + ' yrs';
      }
    }

    // Notable tokens
    const stables = ['USDT', 'USDC', 'DAI', 'BUSD'];
    const notable = tokens.filter(t => stables.includes(t.symbol) || parseFloat(t.usd_value || 0) > 10);

    // Mixer check
    const MIXERS = [
      '0x12d66f87a04a9e220c9d6a5d87e8f396bdd3b51a',
      '0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936',
      '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf',
    ];
    const mixerTxCount = txList.filter(tx =>
      MIXERS.includes((tx.to_address || '').toLowerCase()) ||
      MIXERS.includes((tx.from_address || '').toLowerCase())
    ).length;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        balance: balRaw + ' ' + symbol,
        netWorth,
        txCount: txData.total ? String(txData.total) : String(txList.length),
        age,
        mixerTxCount,
        tokens: notable.slice(0, 3).map(t => ({
          symbol: t.symbol,
          balance: t.balance,
          decimals: t.decimals,
          usdValue: t.usd_value,
        })),
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
