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
  const h = { 'TRON-PRO-API-KEY': TRON_KEY, 'Accept': 'application/json', 'Content-Type': 'application/json' };

  try {
    // Try Tronscan API as alternative — more reliable for balance
    const tronscanRes = await fetch(
      `https://apilist.tronscanapi.com/api/accountv2?address=${addr}`,
      { headers: { 'TRON-PRO-API-KEY': TRON_KEY } }
    );
    const tronscan = await tronscanRes.json();

    let trxBalance = '0';
    let usdtBal = '0';
    let age = 'N/A';
    let txCount = '0';
    let trc20Count = 0;

    if (tronscan && tronscan.balance !== undefined) {
      trxBalance = (tronscan.balance / 1e6).toFixed(2);
    }

    if (tronscan && tronscan.date_created) {
      const yrs = ((Date.now() - tronscan.date_created) / 31536000000).toFixed(1);
      age = yrs + ' yrs';
    }

    if (tronscan && tronscan.totalTransactionCount !== undefined) {
      txCount = String(tronscan.totalTransactionCount);
    }

    // TRC20 tokens from Tronscan
    if (tronscan && tronscan.trc20token_balances) {
      const tokens = tronscan.trc20token_balances;
      trc20Count = tokens.length;
      const usdt = tokens.find(t =>
        t.tokenId === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' ||
        t.tokenAbbr === 'USDT'
      );
      if (usdt) {
        usdtBal = (parseInt(usdt.balance) / Math.pow(10, usdt.tokenDecimal || 6)).toFixed(2);
      }
    }

    // Fallback: TronGrid v1 if Tronscan empty
    if (trxBalance === '0' && txCount === '0') {
      const v1Res = await fetch(
        `https://api.trongrid.io/v1/accounts/${addr}?only_confirmed=true`,
        { headers: h }
      );
      const v1Data = await v1Res.json();
      const acc = v1Data.data && v1Data.data.length > 0 ? v1Data.data[0] : null;

      if (acc) {
        trxBalance = acc.balance ? (acc.balance / 1e6).toFixed(2) : '0';
        if (acc.create_time) {
          age = ((Date.now() - acc.create_time) / 31536000000).toFixed(1) + ' yrs';
        }
        // TRC20 from v1
        const trc20 = acc.trc20 || [];
        trc20Count = trc20.length;
        const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
        for (const t of trc20) {
          if (t[USDT]) {
            usdtBal = (parseInt(t[USDT]) / 1e6).toFixed(2);
            break;
          }
        }
      }

      // TX count via transfers endpoint
      const txRes = await fetch(
        `https://api.trongrid.io/v1/accounts/${addr}/transactions?limit=50&only_confirmed=true`,
        { headers: h }
      );
      const txData = await txRes.json();
      const list = txData.data || [];
      txCount = list.length >= 50 ? '50+' : String(list.length);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ trxBalance, usdtBal, age, txCount, trc20Count, trc20: [] }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
