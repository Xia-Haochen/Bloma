import { mountTokenMonitor } from './app.js';

async function json(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json();
}

mountTokenMonitor(document.body, {
  read: () => json('/api/usage'),
  refreshPrices: () => json('/api/pricing/refresh', {method: 'POST'}),
  openSource: (_provider, url) => window.open(url, '_blank', 'noopener,noreferrer'),
});
