// Worker entry point. workerd treats every named export of this module as an
// entrypoint, so only the handler and the Durable Object class are exported here.
import { createWorker } from './app.js';
export { DailyQuota } from './quota.js';
export default createWorker();
