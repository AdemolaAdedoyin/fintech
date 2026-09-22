// Run with node --env-file=/private/path/test.env scripts/paystack-test-account.mjs [reference].
// This is a read-only account check; hosted checkout completion is documented separately.
const key = process.env.PAYSTACK_SECRET_KEY;
if (!/^sk_test_[A-Za-z0-9]+$/.test(key ?? '')) throw new Error('A Paystack TEST secret key is required; live keys are refused');
const reference = process.argv[2];
if (reference && !/^payment-[0-9a-f-]{36}$/.test(reference)) throw new Error('Invalid reference');
const path = reference ? `/transaction/verify/${encodeURIComponent(reference)}` : '/integration/payment_session_timeout';
const response = await fetch(`https://api.paystack.co${path}`, {headers:{Authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(10000)});
if (!response.ok) throw new Error(`Paystack test-account request failed (${response.status}); no credentials printed`);
const result = await response.json();
if (!result.status) throw new Error('Paystack did not confirm the request');
if (reference) {
  if (result.data?.domain !== 'test' || result.data?.reference !== reference) throw new Error('Test transaction identity mismatch');
  console.log(JSON.stringify({testAccountAuthenticated:true,reference,status:result.data.status,currency:result.data.currency,amountMinor:String(result.data.amount)}));
} else console.log('Paystack test-account authentication verified. Hosted payment and webhook acceptance still pending.');
