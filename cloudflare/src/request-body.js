// Bound streamed requests as well as declared Content-Length; never buffer an
// arbitrarily large chunked tool/consent submission before checking its size.
export async function boundedText(request, maximum) {
  if (Number(request.headers.get('content-length')) > maximum) throw new RangeError('Request too large');
  if (!request.body) return '';
  const reader = request.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new RangeError('Request too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}
