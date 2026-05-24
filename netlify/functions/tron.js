exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const addr = event.queryStringParameters && event.queryStringParameters.addr;
  if (!addr) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No address' }) };

  const TRON_KEY = 'fa93b89a-42f0-42c4-958f-dcdec56dcc15';
  const h = { 'TRON-PRO-API-KEY': TRON_KEY, 'Accept': 'application/json' };

  try {
    // Method 1: wallet/getaccount (more reliable than v1/accounts)
    const accRes = await fetch('https://api.trongrid.io/wallet/getaccount', {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: addr, visible: true }),
    });
    const acc = await accRes.json();
    console.log('Account raw:', JSON.stringify(acc).slice(0, 300));

    const trxBalance = acc.balance ? (acc.balance / 1e6).toFixed(2) : '0';
    const createTime = acc.create_time || acc.createTime || null;
    const age = createTime
      ? ((Date.now() - createTime) / 31536000000).toFixed(1) + ' yrs'
      : 'N/A';

    // TRC20 tokens from trc20 field in account
    const trc20List = acc.trc20 || [];
    let usdtBal = '0';
    const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    
    for (const token of trc20List) {
      if (token[USDT_CONTRACT]) {
        usdtBal = (parseInt(token[USDT_CONTRACT]) / 1e6).toFixed(2);
        break;
      }
    }

    // Transaction count via v1 API
    let txCount = '0';
    try {
      const txRes = await fetch(
        `https://api.trongrid.io/v1/accounts/${addr}/transactions?limit=1&only_confirmed=true`,
        { headers: h }
      );
      const txData = await txRes.json();
      // Get total from meta
      if (txData.meta && txData.meta.page_size !== undefined) {
        // Fetch with larger limit to count
        const txRes2 = await fetch(
          `https://api.trongrid.io/v1/accounts/${addr}/transactions?limit=50&only_confirmed=true`,
          { headers: h }
        );
        const txData2 = await txRes2.json();
        const list = txData2.data || [];
        txCount = list.length >= 50 ? '50+' : String(list.length);
      }
    } catch(e) {
      console.log('TX count error:', e.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        trxBalance,
        usdtBal,
        age,
        txCount,
        trc20Count: trc20List.length,
        trc20: trc20List.slice(0, 3),
        debug: { hasBalance: !!acc.balance, hasCreateTime: !!createTime }
      }),
    };
  } catch (e) {
    console.error('TRON error:', e);
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ error: e.message }) 
    };
  }
};
