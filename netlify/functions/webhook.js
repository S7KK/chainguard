const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const SUPABASE_URL = 'https://rxavfbizccdhrjtzeeeq.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ4YXZmYml6Y2NkaHJqdHplZWVxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTY0MjgwOCwiZXhwIjoyMDk1MjE4ODA4fQ.UdE_oGv2PYvgL0JK_WUzOPNgAFdN69GiVhT_jlhwEgk';
const SITE_URL = 'https://kaleidoscopic-paletas-500492.netlify.app';

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method not allowed' };

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    const payload = JSON.parse(event.body || '{}');
    const { payment_status, order_id } = payload;
    console.log('Webhook:', payment_status, order_id);

    if (!['finished', 'confirmed', 'partially_paid'].includes(payment_status)) {
      return { statusCode: 200, headers, body: JSON.stringify({ received: true }) };
    }

    const { data: payment } = await supabase
      .from('payments')
      .select('*, profiles(email)')
      .eq('nowpayments_id', order_id)
      .single();

    if (!payment || payment.status === 'completed') {
      return { statusCode: 200, headers, body: JSON.stringify({ received: true }) };
    }

    await supabase.from('payments').update({ status: 'completed' }).eq('id', payment.id);

    const { data: profile } = await supabase.from('profiles').select('credits').eq('id', payment.user_id).single();
    const newCredits = (profile?.credits || 0) + payment.credits_added;
    await supabase.from('profiles').update({ credits: newCredits }).eq('id', payment.user_id);

    console.log('Credited', payment.credits_added, 'to user', payment.user_id, '— new balance:', newCredits);

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, credits_added: payment.credits_added }) };
  } catch(e) {
    console.error(e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
