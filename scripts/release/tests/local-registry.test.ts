import { expect, test } from "bun:test"
import { startLocalRegistry } from "../local-registry"

test("rejects non-loopback listeners", async () => {
  await expect(startLocalRegistry({ host: "0.0.0.0" as never, packages: new Map() }))
    .rejects.toThrow("loopback host required")
})

test("rejects invalid local fixtures before binding", async () => {
  await expect(startLocalRegistry({
    host: "127.0.0.1",
    packages: new Map([["bad", {
      name: "bad",
      version: "0.1.0",
      tarball: new Uint8Array(),
      integrity: "sha512-test",
    }]]),
  })).rejects.toThrow("invalid local package fixture")
})

test("serves only package metadata and tarballs while logging every request", async () => {
  const registry = await startLocalRegistry({
    host: "127.0.0.1",
    packages: new Map([["@xiopt/pane-dash-opencode", {
      name: "@xiopt/pane-dash-opencode",
      version: "0.1.0",
      tarball: new TextEncoder().encode("tarball"),
      integrity: "sha512-test",
    }]]),
  })
  try {
    const metadata = await fetch(`${registry.origin}/@xiopt%2fpane-dash-opencode`)
    expect(metadata.status).toBe(200)
    expect(await metadata.json()).toMatchObject({
      name: "@xiopt/pane-dash-opencode",
      "dist-tags": { latest: "0.1.0" },
    })
    const tarball = await fetch(`${registry.origin}/@xiopt%2fpane-dash-opencode/-/pane-dash-opencode-0.1.0.tgz`)
    expect(await tarball.text()).toBe("tarball")
    expect((await fetch(`${registry.origin}/@xiopt%2fpane-dash-opencode`, { method: "POST" })).status).toBe(405)
    expect((await fetch(`${registry.origin}/unrecognized`)).status).toBe(404)
    expect(registry.requests).toEqual([
      "/@xiopt%2fpane-dash-opencode",
      "/@xiopt%2fpane-dash-opencode/-/pane-dash-opencode-0.1.0.tgz",
      "/@xiopt%2fpane-dash-opencode",
      "/unrecognized",
    ])
  } finally {
    await registry.close()
  }
})
