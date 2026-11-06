// Prints a PayPal SANDBOX access token for the PayPal MCP server / AI Toolkit.
// Usage:  node scripts/get-sandbox-token.mjs          (prints the token)
//         node scripts/get-sandbox-token.mjs --env    (prints PAYPAL_ACCESS_TOKEN=... for a shell or .env file)
// Sandbox tokens expire after a few hours; run it again when the MCP server says the token is invalid.
import { cfg } from '../src/config.js';

const { paypal } = cfg();
if (!paypal.clientId || !paypal.clientSecret) {
  console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in your .env file first (PayPal Developer, Apps and Credentials, Sandbox).');
  process.exit(1);
}

const basic = Buffer.from(`${paypal.clientId}:${paypal.clientSecret}`).toString('base64');
const res = await fetch(`${paypal.apiBase}/v1/oauth2/token`, {
  method: 'POST',
  headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials',
});

if (!res.ok) {
  console.error(`PayPal answered HTTP ${res.status}. Check that the credentials are SANDBOX credentials.`);
  process.exit(1);
}

const body = await res.json();
if (process.argv.includes('--env')) console.log(`PAYPAL_ACCESS_TOKEN=${body.access_token}`);
else console.log(body.access_token);
console.error(`Token valid for about ${Math.round((body.expires_in || 0) / 3600)} hour(s).`);
