// Bound streamed requests as well as declared Content-Length; never buffer an
// arbitrarily large chunked tool/consent submission before checking its size.
export async function boundedText(request, maximum, { timeoutMs = 0 } = {}) {
  if (Number(request.headers.get('content-length')) > maximum) throw new RangeError('Request too large');
  if (!request.body) return '';
  const reader = request.body.getReader(), chunks = [];
  let deadline;
  const timeout = timeoutMs > 0 ? new Promise((_, reject) => {
    deadline = setTimeout(() => {
      reject(new Error('Request timed out'));
      // Cancellation is best effort: an uncooperative source must not extend
      // the response deadline by hanging its own cancel callback.
      void reader.cancel().catch(() => {});
    }, timeoutMs);
  }) : null;
  let length = 0;
  try {
    for (;;) {
      const read = reader.read();
      const { done, value } = await (timeout ? Promise.race([read, timeout]) : read);
      if (done) break;
      length += value.byteLength;
      if (length > maximum) { void reader.cancel().catch(() => {}); throw new RangeError('Request too large'); }
      chunks.push(value);
    }
  } finally { clearTimeout(deadline); reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}
