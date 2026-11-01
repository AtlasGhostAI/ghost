// Single-file entry for pasting into the Cloudflare dashboard editor.
// Same handler as index.js, without the Durable Object (the dashboard editor can't
// create DO migrations). Rate limiting falls back to the in-isolate token bucket,
// plus the RATE_LIMITER binding if you add one in the dashboard.
import { createWorker } from './app.js';
export default createWorker();
