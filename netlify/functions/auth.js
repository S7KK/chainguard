const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://rxavfbizccdhrjtzeeeq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ4YXZmYml6Y2NkaHJqdHplZWVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2NDI4MDgsImV4cCI6MjA5NTIxODgwOH0.jKl3QxaerpLzwWPY8w47_ikx0U39BbuHKyXxDoLFKkA';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ4YXZmYml6Y2NkaHJqdHplZWVxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTY0MjgwOCwiZXhwIjoyMDk1MjE4ODA4fQ.UdE_oGv2PYvgL0JK_WUzOPNgAFdN69GiVhT_jlhwEgk';
const SITE_URL = 'https://kaleidoscopic-paletas-500492.netlify.app';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const body = JSON.parse(event.body || '{}');
  const { action, email, password } = body;

  try {
    // REGISTER
    if (action === 'register') {
      const { data, error } = await supabaseAdmin.auth.admin.createUser({
        email, password,
        email_confirm: false,
      });
      if (error) return { statusCode: 400, headers, body: JSON.stringify({ error: error.message }) };
      
      // Send confirmation email via Supabase built-in
      await supabaseClient.auth.signUp({
        email, password,
        options: { emailRedirectTo: SITE_URL + '/dashboard' }
      });

      return { statusCode: 200, headers, body: JSON.stringify({
        success: true,
        message: 'Check your email to confirm your account.',
        userId: data.user.id
      })};
    }

    // LOGIN
    if (action === 'login') {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid email or password' }) };

      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('credits, total_scans, created_at')
        .eq('id', data.user.id)
        .single();

      return { statusCode: 200, headers, body: JSON.stringify({
        success: true,
        token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        user: {
          id: data.user.id,
          email: data.user.email,
          credits: profile?.credits ?? 0,
          total_scans: profile?.total_scans ?? 0,
        }
      })};
    }

    // GET PROFILE + HISTORY
    if (action === 'profile') {
      const authHeader = event.headers.authorization || event.headers.Authorization || '';
      const jwt = authHeader.replace('Bearer ', '');
      if (!jwt) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

      const { data: { user }, error } = await supabaseClient.auth.getUser(jwt);
      if (error || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) };

      const [profileRes, scansRes, paymentsRes] = await Promise.all([
        supabaseAdmin.from('profiles').select('credits, total_scans, created_at').eq('id', user.id).single(),
        supabaseAdmin.from('scans').select('id, address, network, risk_score, risk_level, created_at, report_url').eq('user_id', user.id).order('created_at', { ascending: false }).limit(20),
        supabaseAdmin.from('payments').select('amount_usd, credits_added, package_name, status, created_at').eq('user_id', user.id).order('created_at', { ascending: false }).limit(10),
      ]);

      return { statusCode: 200, headers, body: JSON.stringify({
        user: { id: user.id, email: user.email },
        profile: profileRes.data || { credits: 0, total_scans: 0 },
        scans: scansRes.data || [],
        payments: paymentsRes.data || [],
      })};
    }

    // FORGOT PASSWORD
    if (action === 'forgot') {
      await supabaseClient.auth.resetPasswordForEmail(email, {
        redirectTo: SITE_URL + '/?reset=1',
      });
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // DEDUCT CREDIT (after scan)
    if (action === 'deduct') {
      const authHeader = event.headers.authorization || event.headers.Authorization || '';
      const jwt = authHeader.replace('Bearer ', '');
      const { data: { user } } = await supabaseClient.auth.getUser(jwt);
      if (!user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

      const { data: profile } = await supabaseAdmin.from('profiles').select('credits').eq('id', user.id).single();
      if (!profile || profile.credits < 1) return { statusCode: 402, headers, body: JSON.stringify({ error: 'Insufficient credits' }) };

      await supabaseAdmin.from('profiles').update({
        credits: profile.credits - 1,
        total_scans: (profile.total_scans || 0) + 1,
      }).eq('id', user.id);

      // Save scan record
      const { scanData } = body;
      if (scanData) {
        await supabaseAdmin.from('scans').insert({
          user_id: user.id,
          address: scanData.address,
          network: scanData.network || 'Unknown',
          risk_score: scanData.risk_score || 0,
          risk_level: scanData.risk_level || 'unknown',
          risk_flags: scanData.risk_flags || [],
          chain_data: scanData.chain_data || {},
        });
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, credits: profile.credits - 1 }) };
    }

    // REDEEM PROMO CODE
    if (action === 'promo') {
      const authHeader = event.headers.authorization || event.headers.Authorization || '';
      const jwt = authHeader.replace('Bearer ', '');
      if (!jwt) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

      const { data: { user }, error: authErr } = await supabaseClient.auth.getUser(jwt);
      if (authErr || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) };

      const code = (body.code || '').toUpperCase().trim();
      if (!code) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Промокод не вказано' }) };

      // Check promo exists
      const { data: promo, error: promoErr } = await supabaseAdmin
        .from('promo_codes')
        .select('*')
        .eq('code', code)
        .single();

      if (promoErr || !promo) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Промокод не знайдено або вже недійсний' }) };

      // Check expiry
      if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Термін дії промокоду закінчився' }) };
      }

      // Check max uses
      if (promo.max_uses !== null && promo.used_count >= promo.max_uses) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Промокод вже використано максимальну кількість разів' }) };
      }

      // Check if user already used this code
      const { data: alreadyUsed } = await supabaseAdmin
        .from('promo_uses')
        .select('id')
        .eq('user_id', user.id)
        .eq('code', code)
        .single();

      if (alreadyUsed) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ви вже використовували цей промокод' }) };

      // Add credits to user
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('credits')
        .eq('id', user.id)
        .single();

      const newCredits = (profile?.credits || 0) + promo.credits;

      const [updateRes, useRes, countRes] = await Promise.all([
        supabaseAdmin.from('profiles').update({ credits: newCredits }).eq('id', user.id),
        supabaseAdmin.from('promo_uses').insert({ user_id: user.id, code, credits_added: promo.credits }),
        supabaseAdmin.from('promo_codes').update({ used_count: promo.used_count + 1 }).eq('code', code),
      ]);

      return { statusCode: 200, headers, body: JSON.stringify({
        success: true,
        credits_added: promo.credits,
        new_balance: newCredits,
        message: `✅ Промокод активовано! +${promo.credits} кредитів нараховано.`,
      })};
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch(e) {
    console.error(e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
