// Stand-ins for the Workers AI binding (env.AI) when the app runs on a home
// server. src/ai.js calls env.AI.run(model, input) with Workers AI shaped
// input; each provider below turns that into its own API call and answers
// with { response } the way Workers AI does.
//
//   AI_PROVIDER=cloudflare  Workers AI over its REST API: same models and free
//                           allowance as before. Needs CF_ACCOUNT_ID, CF_API_TOKEN.
//   AI_PROVIDER=openai      Any OpenAI-compatible API: OpenAI, Gemini, OpenRouter,
//                           or Ollama on the home server. Needs AI_BASE_URL,
//                           AI_API_KEY (not for Ollama), AI_MODEL, AI_VISION_MODEL.
//   AI_PROVIDER=anthropic   Claude. Needs AI_API_KEY, AI_MODEL, AI_VISION_MODEL.

export function makeAi(env) {
  const provider = (env.AI_PROVIDER || (env.CF_ACCOUNT_ID && env.CF_API_TOKEN ? 'cloudflare' : '')).toLowerCase();
  if (!provider || provider === 'none') return null;
  if (provider === 'cloudflare') return cloudflare(env);
  if (provider === 'openai') return openai(env);
  if (provider === 'anthropic') return anthropic(env);
  throw new Error(`Unknown AI_PROVIDER "${provider}" (use cloudflare, openai, anthropic or none)`);
}

// fetch() only says "fetch failed" when the AI server can't be reached; the
// reason (ENOTFOUND ollama, ECONNREFUSED, ...) is in err.cause.
async function send(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    const why = err?.cause?.code || err?.cause?.message || err?.message || String(err);
    throw new Error(`can't reach ${new URL(url).origin}: ${why}`);
  }
}

async function post(url, headers, body) {
  const res = await send(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = data?.errors?.[0]?.message || data?.error?.message || data?.error || text.slice(0, 300);
    throw new Error(`${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return data;
}

/* ------------------------------- Cloudflare ------------------------------- */

function cloudflare(env) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) throw new Error('AI_PROVIDER=cloudflare needs CF_ACCOUNT_ID and CF_API_TOKEN');
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/`;
  return {
    async run(model, input) {
      const data = await post(base + model, { authorization: `Bearer ${env.CF_API_TOKEN}` }, input);
      if (data?.success === false) throw new Error(data.errors?.[0]?.message || 'Workers AI error');
      return data?.result ?? data;
    },
  };
}

/* ------------------------- Shared input translation ------------------------ */

// src/ai.js names Workers AI models (@cf/...) for its defaults and its photo
// fallbacks. Other providers use the models from the settings instead.
function pickModel(env, model, input) {
  if (!String(model).startsWith('@cf/')) return model;
  const hasImage = !!input.image || (input.messages || []).some((m) => Array.isArray(m.content));
  if (!hasImage) return env.AI_MODEL;
  // A vision model was already tried under AI_VISION_MODEL; this is a fallback.
  if (env.AI_VISION_FALLBACK_MODEL) return env.AI_VISION_FALLBACK_MODEL;
  throw new Error('no fallback vision model set (AI_VISION_FALLBACK_MODEL)');
}

// Workers AI also accepts { messages, image: base64 }; fold the image into the
// last user message the standard way.
function normalizeMessages(input) {
  const messages = (input.messages || [{ role: 'user', content: input.prompt || '' }]).map((m) => ({ ...m }));
  if (input.image) {
    const last = messages.at(-1);
    const url = `data:image/jpeg;base64,${input.image}`;
    last.content = [{ type: 'text', text: String(last.content) }, { type: 'image_url', image_url: { url } }];
  }
  return messages;
}

/* ---------------------------- OpenAI-compatible ---------------------------- */

function openai(env) {
  if (!env.AI_MODEL || !env.AI_VISION_MODEL) throw new Error('AI_PROVIDER=openai needs AI_MODEL and AI_VISION_MODEL');
  const base = (env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const headers = env.AI_API_KEY ? { authorization: `Bearer ${env.AI_API_KEY}` } : {};
  return {
    async run(model, input) {
      if (input.prompt === 'agree') return { response: 'ok' };
      const body = {
        model: pickModel(env, model, input),
        messages: normalizeMessages(input),
        max_tokens: input.max_tokens,
        temperature: input.temperature,
      };
      // JSON mode in its most widely supported form; the prompt describes the shape.
      if (input.response_format) body.response_format = { type: 'json_object' };
      return { response: await streamChat(`${base}/chat/completions`, headers, body) };
    },
    // Run at startup so the log says straight away if the AI server is down or
    // the model was never downloaded.
    async check() {
      const res = await send(`${base}/models`, { headers });
      if (!res.ok) throw new Error(`${res.status} from ${base}/models: ${(await res.text()).slice(0, 200)}`);
      const ids = ((await res.json())?.data || []).map((m) => m.id);
      const missing = [...new Set([env.AI_MODEL, env.AI_VISION_MODEL])].filter((m) => !ids.includes(m));
      if (missing.length) throw new Error(`model ${missing.join(', ')} not found at ${base} (has: ${ids.join(', ') || 'none'})`);
    },
  };
}

// Streams the answer so slow local models (Ollama on a CPU can take minutes
// per photo) don't hit fetch's five-minute wait for the first byte.
async function streamChat(url, headers, body) {
  const res = await send(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = text.slice(0, 300);
    try {
      const e = JSON.parse(text).error;
      msg = typeof e === 'string' ? e : e?.message || msg;
    } catch {}
    throw new Error(`${res.status}: ${msg}`);
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let out = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return out;
      try {
        out += JSON.parse(data).choices?.[0]?.delta?.content || '';
      } catch {}
    }
  }
  return out;
}

/* -------------------------------- Anthropic -------------------------------- */

function anthropic(env) {
  if (!env.AI_API_KEY || !env.AI_MODEL || !env.AI_VISION_MODEL) {
    throw new Error('AI_PROVIDER=anthropic needs AI_API_KEY, AI_MODEL and AI_VISION_MODEL');
  }
  const base = (env.AI_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const toBlock = (part) => {
    if (part.type !== 'image_url') return { type: 'text', text: part.text };
    const m = /^data:([^;]+);base64,(.*)$/s.exec(part.image_url.url);
    return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  };
  return {
    async run(model, input) {
      if (input.prompt === 'agree') return { response: 'ok' };
      const all = normalizeMessages(input);
      const system = all.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const messages = all
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: Array.isArray(m.content) ? m.content.map(toBlock) : m.content }));
      const data = await post(
        `${base}/v1/messages`,
        { 'x-api-key': env.AI_API_KEY, 'anthropic-version': '2023-06-01' },
        {
          model: pickModel(env, model, input),
          system: system || undefined,
          messages,
          max_tokens: input.max_tokens || 3000,
          temperature: input.temperature,
        },
      );
      return { response: (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('') };
    },
  };
}
