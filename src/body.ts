/** 本文を、上限の大きさまで読む。越えたら undefined。 */
export async function readBody(
  request: Request | Response,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > maxBytes) {
    await request.body?.cancel();
    return undefined;
  }
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

/**
 * 残った本文を捨てる。読み始めた本文はロックされていて、`cancel()` が reject するので、握りつぶす
 * (読み終えた後に呼んでも、処理を止めない)。
 */
export async function discardBody(response: Response | undefined): Promise<void> {
  await response?.body?.cancel().catch(() => {});
}
