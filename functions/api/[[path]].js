import { handleApi } from '../../src/api.js';

export function onRequest({ request, env }) {
  return handleApi(request, env);
}
