export interface LocalPackage {
  readonly name: string
  readonly version: string
  readonly tarball: Uint8Array
  readonly integrity: string
}

export interface LocalRegistry {
  readonly origin: string
  readonly requests: readonly string[]
  close(): Promise<void>
}

const MAX_REQUESTS = 128
const MAX_REQUEST_PATH_BYTES = 512
const MAX_TARBALL_BYTES = 64 * 1024 * 1024

function recordRequest(requests: string[], path: string): void {
  if (requests.length < MAX_REQUESTS) requests.push(path.slice(0, MAX_REQUEST_PATH_BYTES))
}

export async function startLocalRegistry(input: {
  host: "127.0.0.1" | "::1"
  packages: ReadonlyMap<string, LocalPackage>
}): Promise<LocalRegistry> {
  if (input.host !== "127.0.0.1" && input.host !== "::1") {
    throw new Error("loopback host required")
  }
  for (const pkg of input.packages.values()) {
    if (!pkg.name.startsWith("@") || pkg.name.includes("\0") || pkg.tarball.byteLength > MAX_TARBALL_BYTES) {
      throw new Error("invalid local package fixture")
    }
  }

  const requests: string[] = []
  let origin = ""
  const server = Bun.serve({
    hostname: input.host,
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      recordRequest(requests, url.pathname)
      if (request.method !== "GET") return new Response("method not allowed", { status: 405 })
      const decodedPath = decodeURIComponent(url.pathname)
      const packageName = [...input.packages.keys()].find((name) => decodedPath === `/${name}`)
      if (packageName) {
        const pkg = input.packages.get(packageName)!
        const encoded = encodeURIComponent(pkg.name)
        const unscoped = pkg.name.slice(pkg.name.lastIndexOf("/") + 1)
        return Response.json({
          name: pkg.name,
          "dist-tags": { latest: pkg.version },
          versions: {
            [pkg.version]: {
              name: pkg.name,
              version: pkg.version,
              dist: {
                integrity: pkg.integrity,
                tarball: `${origin}/${encoded}/-/${unscoped}-${pkg.version}.tgz`,
              },
            },
          },
        })
      }

      for (const pkg of input.packages.values()) {
        const unscoped = pkg.name.slice(pkg.name.lastIndexOf("/") + 1)
        if (decodedPath === `/${pkg.name}/-/${unscoped}-${pkg.version}.tgz`) {
          return new Response(pkg.tarball, { headers: { "content-type": "application/octet-stream" } })
        }
      }
      return new Response("not found", { status: 404 })
    },
  })
  const host = input.host.includes(":") ? `[${input.host}]` : input.host
  origin = `http://${host}:${server.port}`

  return {
    origin,
    requests,
    async close() {
      await server.stop(true)
    },
  }
}
