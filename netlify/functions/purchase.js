const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://rxavfbizccdhrjtzeeeq.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ4YXZmYml6Y2NkaHJqdHplZWVxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTY0MjgwOCwiZXhwIjoyMDk1MjE4ODA4fQ.UdE_oGv2PYvgL0JK_WUzOPNgAFdN69GiVhT_jlhwEgk';
const NOWPAYMENTS_KEY = 'J0D9K56-E7WMRSX-JPPFS43-M2QCCVS';
const SITE_URL = 'https://kaleidoscopic-paletas-500492.netlify.app';

const PACKAGES = {
  single:   { name: '1 Report',      price: 19.99, credits: 1 },
  starter:  { name: 'Starter Pack',  price:  9.99, credits: 3 },
  basic:    { name: 'Basic Pack',    price: 24.99, credits: 10 },
  pro:      { name: 'Pro Pack',      price: 49.99, credits: 30 },
  business: { name: 'Business Pack', price: 99.99, credits: 100 },
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const body = JSON.parse(event.body || '{}');
  const { packageId, userId } = body;
  const pkg = PACKAGES[packageId] || PACKAGES.single;
  const orderId = 'cg_' + Date.now() + '_' + (packageId || 'single');

  try {
    const nowRes = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: { 'x-api-key': NOWPAYMENTS_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price_amount: pkg.price,
        price_currency: 'usd',
        order_id: orderId,
        order_description: 'ChainGuard ' + pkg.name,
        success_url: SITE_URL + '/dashboard?payment=success',
        cancel_url: SITE_URL + '/?payment=cancelled',
        is_fixed_rate: false,
        is_fee_paid_by_user: false,
      }),
    });

    const invoice = await nowRes.json();
    if (!invoice.invoice_url) throw new Error(invoice.message || 'Invoice creation failed');

    if (userId) {
      await supabase.from('payments').insert({
        user_id: userId,
        amount_usd: pkg.price,
        credits_added: pkg.credits,
        nowpayments_id: orderId,
        status: 'pending',
        package_name: pkg.name,
      });
    }

    return { statusCode: 200, headers, body: JSON.stringify({
      invoice_url: invoice.invoice_url,
      order_id: orderId,
      package: pkg,
    })};
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
