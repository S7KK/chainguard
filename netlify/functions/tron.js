exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const addr = event.queryStringParameters && event.queryStringParameters.addr;
  if (!addr) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No address' }) };

  const TRON_KEY = 'fa93b89a-42f0-42c4-958f-dcdec56dcc15';
  const base = 'https://api.trongrid.io';
  const h = { 'TRON-PRO-API-KEY': TRON_KEY, 'Accept': 'application/json' };

  try {
    // Account info
    const accRes = await fetch(`${base}/v1/accounts/${addr}`, { headers: h });
    const accData = await accRes.json();
    const acc = accData.data && accData.data[0] ? accData.data[0] : null;

    const trxBalance = acc ? (acc.balance / 1e6).toFixed(2) : '0';
    const createTime = acc && acc.create_time ? acc.create_time : null;
    const age = createTime
      ? ((Date.now() - createTime) / 31536000000).toFixed(1) + ' yrs'
      : 'N/A';

    // TRC20 tokens
    const tokRes = await fetch(`${base}/v1/accounts/${addr}/tokens?limit=20&token_type=trc20`, { headers: h });
    const tokData = await tokRes.json();
    const trc20 = tokData.data || [];

    // USDT TRC20
    const usdt = trc20.find(t => t.tokenId === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    const usdtBal = usdt ? (parseInt(usdt.balance) / 1e6).toFixed(2) : '0';

    // Transactions
    const txRes = await fetch(`${base}/v1/accounts/${addr}/transactions?limit=50&only_confirmed=true`, { headers: h });
    const txData = await txRes.json();
    const txList = txData.data || [];

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        trxBalance,
        usdtBal,
        age,
        txCount: String(txList.length),
        trc20Count: trc20.length,
        trc20: trc20.slice(0, 5).map(t => ({
          symbol: t.tokenAbbr || t.tokenName,
          balance: t.balance,
          decimals: t.tokenDecimalNum || 6,
        })),
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
