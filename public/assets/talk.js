// "Talk": say what you'd like to cook, and hear recipes read aloud.
//
// Listening uses the browser's speech recognition (Chrome, Edge, Safari).
// Reading uses the home server's voice (Index-TTS, POST /api/tts) a few
// sentences at a time, fetching the next piece while one plays. When there is
// no voice server, or it fails, the browser's own voice reads instead.
import { speechChunks } from './lib.js';

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = window.speechSynthesis;
const SERVER_RETRY = 5 * 60_000; // after a failure, use the browser voice for a while
// A moment of silence: playing it during a tap lets later audio play on phones.
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

const player = new Audio();
let serverOffUntil = 0;
let session = null; // { cancelled, onState }

export const canListen = () => !!Recognition;
export const isSpeaking = () => !!session;

/** The voice server is back: use it again without waiting out the pause. */
export function retryServerVoice() {
  serverOffUntil = 0;
}

/** Call from a click handler, before anything async, so audio may play later. */
export function unlockAudio() {
  player.src = SILENCE;
  player.play().catch(() => {});
  if (synth && !synth.speaking) synth.speak(new SpeechSynthesisUtterance(''));
}

/**
 * Listens for one request. onText(text) gets the words so far; onDone(text)
 * the final words ('' if nothing was heard); onError(message) problems.
 * Returns a function that stops listening early (onDone still runs).
 */
export function listen({ onText, onDone, onError }) {
  const rec = new Recognition();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  let text = '';
  let failed = false;
  rec.onresult = (e) => {
    text = [...e.results].map((r) => r[0].transcript).join(' ').replace(/\s+/g, ' ').trim();
    onText(text);
  };
  rec.onerror = (e) => {
    if (e.error === 'aborted') return;
    failed = true;
    onError(
      {
        'not-allowed': isSecureContext
          ? 'The microphone is blocked. Allow it for this site in the browser settings, then try again.'
          : 'Talking needs the https:// address of Recipe Board; browsers block the microphone on plain http.',
        'service-not-allowed': 'Speech recognition is turned off on this device.',
        'no-speech': "I didn't hear anything. Tap Talk and try again.",
        'audio-capture': 'No microphone was found.',
        network: 'Speech recognition needs an internet connection.',
      }[e.error] || `Listening stopped (${e.error}).`,
    );
  };
  rec.onend = () => {
    if (!failed) onDone(text);
  };
  try {
    rec.start();
  } catch (err) {
    failed = true;
    onError(`Couldn't start listening (${err.message}).`);
  }
  return () => rec.stop();
}

/**
 * Reads text aloud, stopping anything already playing. onState(state) hears
 * 'loading', 'speaking' and finally 'done' (also after stopSpeaking()).
 */
export async function speak(text, { onState = () => {} } = {}) {
  stopSpeaking();
  const me = { cancelled: false, onState, controller: new AbortController() };
  session = me;
  const chunks = speechChunks(text);
  try {
    if (Date.now() >= serverOffUntil) {
      const done = await speakWithServer(me, chunks);
      if (done === chunks.length || me.cancelled) return;
      chunks.splice(0, done);
    }
    if (synth) await speakWithBrowser(me, chunks);
  } finally {
    if (session === me) {
      session = null;
      onState('done');
    }
  }
}

export function stopSpeaking() {
  const me = session;
  if (!me) return;
  me.cancelled = true;
  me.controller.abort();
  player.pause();
  player.onended?.();
  synth?.cancel();
  session = null;
  me.onState('done');
}

async function fetchAudio(text, signal) {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    credentials: 'same-origin',
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `voice server answered ${res.status}`);
  }
  return URL.createObjectURL(await res.blob());
}

/** Plays chunks with the server voice; returns how many were played. */
async function speakWithServer(me, chunks) {
  me.onState('loading');
  const pending = chunks.map(() => null);
  const load = (i) => {
    if (i < chunks.length && !pending[i]) {
      pending[i] = fetchAudio(chunks[i], me.controller.signal);
      pending[i].catch(() => {}); // handled when its turn comes
    }
    return pending[i];
  };
  for (let i = 0; i < chunks.length; i++) {
    let url;
    try {
      url = await load(i);
    } catch (err) {
      if (me.cancelled) return i;
      console.warn('Server voice failed, using the browser voice:', err.message);
      serverOffUntil = Date.now() + SERVER_RETRY;
      return i;
    }
    if (me.cancelled) return i;
    load(i + 1);
    me.onState('speaking');
    await play(url);
    URL.revokeObjectURL(url);
    if (me.cancelled) return i + 1;
  }
  return chunks.length;
}

function play(url) {
  return new Promise((resolve) => {
    player.onended = player.onerror = () => {
      player.onended = player.onerror = null;
      resolve();
    };
    player.src = url;
    player.play().catch(() => player.onended?.());
  });
}

async function speakWithBrowser(me, chunks) {
  me.onState('speaking');
  for (const chunk of chunks) {
    if (me.cancelled) return;
    await new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(chunk);
      u.lang = navigator.language || 'en-US';
      u.onend = u.onerror = resolve;
      synth.speak(u);
    });
  }
}
