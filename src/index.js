import { handleRequest } from './app.js';
import { config } from './config.js';

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, config, env, ctx);
  }
};
