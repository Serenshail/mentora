export class RemoteResponseBodyError extends Error {}

/** Database HTTP deadline covers headers AND body; callers receive an already bounded response. */
export async function remoteResponse(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let receivedHeaders = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error("远端数据库响应超时"));
    }, timeoutMs);
  });
  try {
    const signal = init.signal ? AbortSignal.any([ctrl.signal, init.signal]) : ctrl.signal;
    const res = await Promise.race([fetch(url, { ...init, signal }), timeout]);
    receivedHeaders = true;
    if (!res.body) return res;
    reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      total += value.byteLength;
      // User sync payloads are capped at ingress; allow generous encoding/list overhead.
      if (total > 16 * 1024 * 1024) throw new Error("远端数据库响应过大");
      chunks.push(value);
    }
    return new Response([204, 205, 304].includes(res.status) ? null : Buffer.concat(chunks), {
      status: res.status, statusText: res.statusText, headers: res.headers,
    });
  } catch (e) {
    // A write may already be committed when its acknowledgement body is lost.
    if (receivedHeaders) throw new RemoteResponseBodyError(e instanceof Error ? e.message : "远端数据库响应中断");
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
