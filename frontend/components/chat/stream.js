// Follows one answer while it is being written. Uses a streamed response
// (server-sent events) through core's own axios client, so login and token
// refresh work as everywhere else. If streaming is not possible (older client,
// a proxy that holds data back), it falls back to asking for new text in a
// loop; the answer itself is safe on the server either way.

const FIRST_EVENT_MS = 8000;

async function viaEvents(api, id, onEvent, signal) {
  const inner = new AbortController();
  const stop = () => inner.abort();
  if (signal.aborted) return true;
  signal.addEventListener('abort', stop);
  let timer = setTimeout(stop, FIRST_EVENT_MS);
  try {
    const res = await api.get(`/ai/generations/${id}/events`, {
      adapter: 'fetch', responseType: 'stream', timeout: 0, signal: inner.signal, headers: { Accept: 'text/event-stream' }
    });
    if (!res.data || typeof res.data.getReader !== 'function') return false;
    const reader = res.data.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith('data:')) {
          clearTimeout(timer);
          timer = null;
          const event = JSON.parse(block.slice(5));
          if (event.type === 'done' || (event.type === 'snapshot' && event.generation.state === 'finished')) finished = true;
          onEvent(event);
        }
      }
    }
    return finished;
  } catch (err) {
    if (err.response && err.response.status === 404) throw err;
    return false;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}

async function viaPolling(api, id, onEvent, signal) {
  let content = 0;
  let reasoning = 0;
  let failures = 0;
  while (!signal.aborted) {
    try {
      const res = await api.get(`/ai/generations/${id}`, { params: { wait: 1, content, reasoning }, timeout: 40000, signal });
      const g = res.data.generation;
      failures = 0;
      content = g.content.length;
      reasoning = g.reasoning.length;
      onEvent({ type: 'snapshot', generation: g });
      if (g.state === 'finished') return;
    } catch (err) {
      if (signal.aborted) return;
      if (err.response && err.response.status === 404) throw err;
      failures += 1;
      if (failures > 8) throw err;
      const pause = 1000 * failures;
      await new Promise(r => setTimeout(r, pause));
    }
  }
}

// onEvent gets { type: 'snapshot' | 'queued' | 'start' | 'reasoning' |
// 'content' | 'notice' | 'done', ... }. Rejects with a 404 when the answer is
// already finished and gone from memory: reload the chat then.
export default async function follow(api, id, onEvent, signal) {
  const finished = await viaEvents(api, id, onEvent, signal);
  if (!finished && !signal.aborted) await viaPolling(api, id, onEvent, signal);
}
