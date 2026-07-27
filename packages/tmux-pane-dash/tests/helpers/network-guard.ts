/** Blocks every JavaScript network request except the test fixture origin. */
export function installNetworkGuard(allowedOrigin: string): () => void {
  const origin = new URL(allowedOrigin).origin, original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== origin) throw new Error(`unexpected network request: ${url.origin}`)
    return original(input, init)
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}
