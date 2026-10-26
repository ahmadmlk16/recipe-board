// Text to speech for the "Talk" option, home server only. Like server/ai.mjs
// it makes a binding (env.TTS) that src/api.js calls; without one the app
// reads aloud with the browser's own voice instead.
//
//   TTS_PROVIDER=indextts  Index-TTS WebUI (Gradio), e.g. the ZimaOS App Store
//                          app. Needs TTS_BASE_URL and a voice sample:
//                          Index-TTS copies the voice of a short recording,
//                          TTS_VOICE_FILE (default /data/voice.wav).
//   TTS_PROVIDER=openai    Any OpenAI-style /v1/audio/speech server. Needs
//                          TTS_BASE_URL (ending in /v1); TTS_API_KEY,
//                          TTS_MODEL and TTS_VOICE are optional.
//
// TTS_PROVIDER defaults to indextts when TTS_BASE_URL is set.
import fs from 'node:fs/promises';
import path from 'node:path';

export function makeTts(env) {
  const provider = (env.TTS_PROVIDER || (env.TTS_BASE_URL ? 'indextts' : '')).toLowerCase();
  if (!provider || provider === 'none') return null;
  if (!env.TTS_BASE_URL) throw new Error(`TTS_PROVIDER=${provider} needs TTS_BASE_URL`);
  if (provider === 'indextts' || provider === 'gradio') return indexTts(env);
  if (provider === 'openai') return openaiTts(env);
  throw new Error(`Unknown TTS_PROVIDER "${provider}" (use indextts, openai or none)`);
}

const timeoutMs = (env) => (Number(env.TTS_TIMEOUT_SECONDS) || 120) * 1000;

// Same as in server/ai.mjs: say why the server can't be reached.
async function send(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new Error(`${new URL(url).origin} took too long to answer`);
    const why = err?.cause?.code || err?.cause?.message || err?.message || String(err);
    throw new Error(`can't reach ${new URL(url).origin}: ${why}`);
  }
}

async function failed(res, url) {
  return new Error(`${res.status} from ${url}: ${(await res.text()).slice(0, 200)}`);
}

/* -------------------------------- Index-TTS ------------------------------- */

// Talks to the WebUI the way Gradio's own client does: upload the voice
// sample, start a job, read the job's event stream, download the audio.
// Index-TTS versions take different inputs, so they are read from the
// server's /info and every input except the voice and the text keeps the
// WebUI's default.
function indexTts(env) {
  const base = env.TTS_BASE_URL.replace(/\/+$/, '');
  const voiceFile = path.resolve(env.TTS_VOICE_FILE || path.join(env.DATA_DIR || '/data', 'voice.wav'));
  let api = null; // { prefix, name, params }
  let voice = null; // { path, mtime } of the uploaded sample on the Gradio server

  async function loadApi() {
    for (const prefix of ['/gradio_api', '']) {
      const url = `${base}${prefix}/info`;
      const res = await send(url, { signal: AbortSignal.timeout(5000) });
      if (res.status === 404) continue;
      if (!res.ok) throw await failed(res, url);
      const endpoints = (await res.json())?.named_endpoints || {};
      const name = env.TTS_ENDPOINT || ('/gen_single' in endpoints ? '/gen_single' : Object.keys(endpoints).find((n) => endpoints[n].parameters?.some(isAudio)));
      if (!name || !endpoints[name]) throw new Error(`no text-to-speech endpoint at ${base} (has: ${Object.keys(endpoints).join(', ') || 'none'})`);
      return { prefix, name, params: endpoints[name].parameters || [] };
    }
    throw new Error(`${base} does not look like a Gradio app (no /info)`);
  }

  async function readVoice() {
    try {
      const [stat, bytes] = await Promise.all([fs.stat(voiceFile), fs.readFile(voiceFile)]);
      return { bytes, mtime: stat.mtimeMs };
    } catch {
      throw new Error(`no voice sample at ${voiceFile}. Index-TTS copies the voice of a 5 to 15 second recording; put one there as a WAV file`);
    }
  }

  async function uploadVoice() {
    const { bytes, mtime } = await readVoice();
    if (voice && voice.mtime === mtime) return voice.path;
    const form = new FormData();
    form.append('files', new Blob([bytes], { type: 'audio/wav' }), path.basename(voiceFile));
    const url = `${base}${api.prefix}/upload`;
    const res = await send(url, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw await failed(res, url);
    const [serverPath] = await res.json();
    voice = { path: serverPath, mtime };
    return serverPath;
  }

  async function generate(text) {
    api ||= await loadApi();
    const voicePath = await uploadVoice();
    const data = buildInputs(api.params, text, voicePath, env.TTS_LANG);
    const call = `${base}${api.prefix}/call${api.name}`;
    const started = await send(call, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!started.ok) throw await failed(started, call);
    const { event_id: id } = await started.json();
    const stream = await send(`${call}/${id}`, { signal: AbortSignal.timeout(timeoutMs(env)) });
    if (!stream.ok) throw await failed(stream, call);
    const output = readEvents(await stream.text());
    // The audio comes as a file, or wrapped in an update: { value: file, visible }.
    const file = [output].flat().map((o) => o?.value ?? o).find((o) => o && (o.path || o.url));
    if (!file) throw new Error('Index-TTS answered without audio');
    // Build the link from our base URL; Gradio's own url uses whatever
    // address it thinks it has.
    const audioUrl = file.path ? `${base}${api.prefix}/file=${file.path}` : file.url;
    const audio = await send(audioUrl, { signal: AbortSignal.timeout(30_000) });
    if (!audio.ok) throw await failed(audio, audioUrl);
    // Gradio serves files as application/octet-stream, which Safari won't play.
    const type = /^audio\//.test(audio.headers.get('content-type') || '') ? audio.headers.get('content-type') : /\.mp3$/i.test(file.path || file.url) ? 'audio/mpeg' : 'audio/wav';
    return { bytes: new Uint8Array(await audio.arrayBuffer()), type };
  }

  return {
    async speak(text) {
      try {
        return await generate(text);
      } catch (err) {
        // The WebUI may have restarted since: its inputs or our uploaded
        // voice can be gone. Look again once.
        if ((!api && !voice) || !/\b404\b|not found|no such file|cannot be accessed/i.test(err.message)) throw err;
        api = null;
        voice = null;
        return generate(text);
      }
    },
    async check() {
      api = await loadApi();
      await readVoice();
    },
  };
}

const isAudio = (p) => p.component === 'Audio' || p.component === 'File';

/** Gradio inputs for one job: the voice, the text, and defaults for the rest. */
export function buildInputs(params, text, voicePath, lang) {
  const voiceAt = params.findIndex((p) => p.parameter_name === 'prompt');
  const voiceIndex = voiceAt >= 0 ? voiceAt : params.findIndex(isAudio);
  const named = params.findIndex((p) => p.parameter_name === 'text');
  const textIndex = named >= 0 ? named : params.findIndex((p) => ['Textbox', 'TextArea'].includes(p.component));
  return params.map((p, i) => {
    if (i === voiceIndex) return { path: voicePath, meta: { _type: 'gradio.FileData' } };
    if (i === textIndex) return text;
    // Index-TTS 2.5 asks which language the text is in; the app is in English.
    if (/^lang/.test(p.parameter_name || '')) return lang || 'EN';
    return p.parameter_has_default ? p.parameter_default : null;
  });
}

/** The result of a Gradio job from its event stream (text/event-stream). */
export function readEvents(body) {
  let event = '';
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) {
      const data = line.slice(5).trim();
      if (event === 'complete') return JSON.parse(data);
      if (event === 'error') {
        let msg = data;
        try {
          msg = JSON.parse(data) ?? 'no details';
        } catch {}
        throw new Error(`Index-TTS failed: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`.slice(0, 300));
      }
    }
  }
  throw new Error('Index-TTS stopped before the audio was ready');
}

/* ------------------------------ OpenAI-style ------------------------------ */

function openaiTts(env) {
  const base = env.TTS_BASE_URL.replace(/\/+$/, '');
  const headers = env.TTS_API_KEY ? { authorization: `Bearer ${env.TTS_API_KEY}` } : {};
  return {
    async speak(text) {
      const url = `${base}/audio/speech`;
      const res = await send(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model: env.TTS_MODEL || 'tts-1', voice: env.TTS_VOICE || 'alloy', input: text, response_format: 'mp3' }),
        signal: AbortSignal.timeout(timeoutMs(env)),
      });
      if (!res.ok) throw await failed(res, url);
      return { bytes: new Uint8Array(await res.arrayBuffer()), type: res.headers.get('content-type') || 'audio/mpeg' };
    },
  };
}
