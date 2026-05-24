const ETHERSCAN_KEY = 'PQBSB54WJ3DR6IIAVEBE3IHHKSRMMHQUJK';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const { addr } = event.queryStringParameters || {};
  if (!addr) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No address' }) };

  const base = 'https://api.etherscan.io/api';
  const k = ETHERSCAN_KEY;

  try {
    const [balRes, txRes] = await Promise.all([
      fetch(`${base}?module=account&action=balance&address=${addr}&tag=latest&apikey=${k}`),
      fetch(`${base}?module=account&action=txlist&address=${addr}&startblock=0&endblock=99999999&page=1&offset=100&sort=asc&apikey=${k}`),
    ]);
    const [balData, txData] = await Promise.all([balRes.json(), txRes.json()]);

    const balEth = balData.status === '1' ? (parseInt(balData.result) / 1e18).toFixed(4) + ' ETH' : '0 ETH';
    const txList = txData.status === '1' ? txData.result : [];
    const txCount = txList.length >= 100 ? '100+' : String(txList.length);

    let age = 'N/A';
    if (txList.length > 0) {
      const yrs = ((Date.now() / 1000 - parseInt(txList[0].timeStamp)) / 31536000).toFixed(1);
      age = yrs + ' yrs';
    }

    const MIXERS = ['0x12d66f87a04a9e220c9d6a5d87e8f396bdd3b51a','0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936','0x910cbd523d972eb0a6f4cae4618ad62622b39dbf'];
    const mixerTxCount = txList.filter(tx => MIXERS.includes(tx.to) || MIXERS.includes(tx.from)).length;

    return { statusCode: 200, headers, body: JSON.stringify({ balance: balEth, txCount, age, mixerTxCount }) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
