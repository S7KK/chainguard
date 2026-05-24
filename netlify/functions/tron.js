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
    // Run all requests in parallel
    const [tronscanRes, goplusRes, txRes, trc20Res] = await Promise.allSettled([
      // 1. Tronscan account info
      fetch(`https://apilist.tronscanapi.com/api/accountv2?address=${addr}`, { headers: h }),
      // 2. GoPlus Security — malicious address check
      fetch(`https://api.gopluslabs.io/api/v1/address_security/${addr}?chain_id=tron`),
      // 3. Transaction list
      fetch(`https://api.trongrid.io/v1/accounts/${addr}/transactions?limit=50&only_confirmed=true`, { headers: h }),
      // 4. TRC20 token list
      fetch(`https://apilist.tronscanapi.com/api/account/tokens?address=${addr}&start=0&limit=20&token_type=trc20`, { headers: h }),
    ]);

    // Parse Tronscan
    let trxBalance = '0', usdtBal = '0', age = 'N/A', txCount = '0';
    let frozenTrx = '0', energy = '0', bandwidth = '0';
    let isContract = false, trc20List = [];

    if (tronscanRes.status === 'fulfilled' && tronscanRes.value.ok) {
      const ts = await tronscanRes.value.json();
      trxBalance = ts.balance ? (ts.balance / 1e6).toFixed(2) : '0';
      frozenTrx = ts.frozen && ts.frozen.total ? (ts.frozen.total / 1e6).toFixed(2) : '0';
      energy = ts.accountResource && ts.accountResource.energy_limit ? String(ts.accountResource.energy_limit) : '0';
      bandwidth = ts.bandwidth && ts.bandwidth.netLimit ? String(ts.bandwidth.netLimit) : '0';
      isContract = ts.accountType === 1;
      if (ts.date_created) {
        age = ((Date.now() - ts.date_created) / 31536000000).toFixed(1) + ' yrs';
      }
      txCount = ts.totalTransactionCount ? String(ts.totalTransactionCount) : '0';
      if (ts.trc20token_balances) {
        trc20List = ts.trc20token_balances.slice(0, 10).map(t => ({
          symbol: t.tokenAbbr || t.tokenName,
          balance: (parseInt(t.balance) / Math.pow(10, t.tokenDecimal || 6)).toFixed(2),
          name: t.tokenName,
        }));
        const usdt = ts.trc20token_balances.find(t =>
          t.tokenId === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' || t.tokenAbbr === 'USDT'
        );
        if (usdt) usdtBal = (parseInt(usdt.balance) / Math.pow(10, usdt.tokenDecimal || 6)).toFixed(2);
      }
    }

    // Parse GoPlus Security
    let riskFlags = [];
    let goplusRisk = false;
    if (goplusRes.status === 'fulfilled' && goplusRes.value.ok) {
      const gp = await goplusRes.value.json();
      const r = gp.result && gp.result[addr.toLowerCase()] ? gp.result[addr.toLowerCase()] : gp.result || {};
      if (r.blacklist_doubt === '1') { riskFlags.push('Blacklist suspect'); goplusRisk = true; }
      if (r.cybercrime === '1') { riskFlags.push('Cybercrime associated'); goplusRisk = true; }
      if (r.money_laundering === '1') { riskFlags.push('Money laundering flagged'); goplusRisk = true; }
      if (r.phishing_activities === '1') { riskFlags.push('Phishing activity detected'); goplusRisk = true; }
      if (r.darkweb_transactions === '1') { riskFlags.push('Darkweb transactions detected'); goplusRisk = true; }
      if (r.fake_token === '1') { riskFlags.push('Fake token associated'); goplusRisk = true; }
      if (r.sanctioned === '1') { riskFlags.push('SANCTIONED ADDRESS'); goplusRisk = true; }
      if (r.stealing_attack === '1') { riskFlags.push('Stealing attack involved'); goplusRisk = true; }
    }

    // Parse TX for mixer detection
    let mixerTxCount = 0;
    const TRON_RISK = [
      'TJDENsfBJs4RFETt1X1uyowk1wEwTESBXm',
      'TNaRAoLUyYEV2uEZqRiCMbQNTerqBTQoLM',
      'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',
    ];
    if (txRes.status === 'fulfilled' && txRes.value.ok) {
      const txData = await txRes.value.json();
      const list = txData.data || [];
      mixerTxCount = list.filter(tx => {
        const contract = tx.raw_data && tx.raw_data.contract && tx.raw_data.contract[0];
        const val = contract && contract.parameter && contract.parameter.value;
        if (!val) return false;
        return TRON_RISK.indexOf(val.to_address) !== -1;
      }).length;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        trxBalance,
        usdtBal,
        age,
        txCount,
        frozenTrx,
        energy,
        bandwidth,
        isContract,
        trc20List,
        mixerTxCount,
        goplusRisk,
        riskFlags,
        trc20Count: trc20List.length,
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
