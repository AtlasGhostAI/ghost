// Public, non-secret site configuration. Safe to commit and deploy.
// NEVER put the Helius API key (or any secret) in this file — everything here is visible to visitors.
window.ATLAS_CONFIG = {
  // Base URL of your deployed Worker, e.g. 'https://atlas-ghost-api.ghostroast.workers.dev'.
  // Leave empty for sample-only mode (live mode is shown as "not enabled").
  apiBase: 'https://atlas-ghost-api.ghostroast.workers.dev',
  // Optional Cloudflare Turnstile SITE key (public). If set, also set TURNSTILE_SECRET_KEY on the Worker.
  turnstileSiteKey: '0x4AAAAAAFrsdEbnHhIgUlKi',
  // Official token contract address. Leave empty until launch; the site shows "Not launched" meanwhile.
  contractAddress: '',
  // Official X handle without @, e.g. 'ghostonsol'. Adds the nav link and the "Follow the ghost" button.
  xHandle: 'AtlasGhostAI',
  // Transparency page: the public dev wallet address (posted at launch), a token-lock proof link, and creator-fee spending.
  devWallet: '',
  lockUrl: '',
  feeLedger: [], // e.g. { date: '2026-11-05', item: 'DexScreener listing', sol: 3.1 }
};
