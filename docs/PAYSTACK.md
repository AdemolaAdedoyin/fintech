# Paystack test-account acceptance

Status: automated provider-contract and settlement tests pass. Real test-account acceptance
is **pending a private test key and checkout completion**. No live funds or deployments are required.
Do not paste keys into chat, commit them, or put them in a URL or shell argument.

1. Store your `sk_test_...` key in a private local environment file, readable only by you.
   Set `PAYMENT_PROVIDER=paystack`, `PAYSTACK_SECRET_KEY`, and `NODE_ENV=development` in the
   local API environment. Use a separate local database from normal mock testing if desired.
   Restart the API when changing environment values. Never use a live key for this procedure.
2. Authenticate the account read-only:
   `node --env-file=/private/path/paystack-test.env scripts/paystack-test-account.mjs`.
   The script refuses live keys and prints no credentials. This check alone is not a payment test.
3. Register a synthetic NGN user locally, then POST an NGN payment for `"10000"` minor units
   with a new Idempotency-Key. Record the payment ID/reference, not the bearer token.
4. Open the returned hosted checkout URL and use the official
   [Paystack test payment details](https://paystack.com/docs/payments/test-payments/).
   Complete any simulated authentication requested by that test scenario.
5. Call authenticated `POST /api/v1/payments/:id/reconcile`. Confirm SUCCEEDED, one provider
   event, one ledger transaction and a wallet credit of exactly NGN 100.00. Repeat the call
   and check the balance stays unchanged. The read-only script can also verify the reference:
   `node --env-file=/private/path/paystack-test.env scripts/paystack-test-account.mjs payment-...`.
6. For actual webhook acceptance, Paystack needs a publicly reachable HTTPS URL. Localhost
   is not reachable from Paystack. A user-approved temporary tunnel to this **test** API is
   sufficient; no production deployment is required. Set its `/api/v1/payments/webhooks/paystack`
   URL in the **test-mode** dashboard, pay a fresh intent, confirm callback settlement, then
   use the dashboard's resend feature to confirm duplicate delivery does not credit twice.
   Close the tunnel and remove its dashboard URL when finished. No tunnel is created by this project.
7. Exercise an abandoned/failed test checkout, amount/currency mismatch fixtures, invalid
   signature fixtures, reconciliation after missed callbacks, and uncertain initialization.
   Never delete immutable records or checkout claims to force a result.

Capture date, test domain, payment/reference IDs, expected/actual balances, duplicate outcome,
and webhook HTTP result in the acceptance record. Exclude secrets, raw authorization objects,
card details and personal data. Keep account authentication, hosted payment, webhook delivery,
and replay results as separate checks so a partial test cannot be mistaken for full acceptance.

Reference: [transaction API](https://paystack.com/docs/api/transaction/),
[webhooks](https://paystack.com/docs/payments/webhooks/). Test mode does not prove live
settlement, refunds, compliance readiness or all real payment-channel behavior.
