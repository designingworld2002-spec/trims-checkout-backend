/**
 * Keeps a public HTTPS localtunnel open in front of the local backend so the
 * live (HTTPS) Shopify storefront can reach it without a mixed-content block.
 *
 *   node tunnel.js
 *
 * Requests a stable subdomain when available, prints the URL, and
 * auto-reconnects if the tunnel drops. Run the backend (server.js) first.
 */
const localtunnel = require('localtunnel');

const PORT = Number(process.env.PORT) || 3000;
const SUBDOMAIN = process.env.LT_SUBDOMAIN || 'trims-draft-test';

async function start() {
  try {
    const tunnel = await localtunnel({ port: PORT, subdomain: SUBDOMAIN });
    console.log('TUNNEL_URL=' + tunnel.url);

    tunnel.on('close', function () {
      console.log('tunnel closed — reconnecting in 2s…');
      setTimeout(start, 2000);
    });
    tunnel.on('error', function (err) {
      console.log('tunnel error:', err && err.message);
    });
  } catch (err) {
    console.error('failed to open tunnel:', err && err.message, '— retrying in 3s');
    setTimeout(start, 3000);
  }
}

start();
// Keep the process alive regardless of tunnel event timing.
setInterval(function () {}, 1 << 30);
