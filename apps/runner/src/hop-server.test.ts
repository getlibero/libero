import { afterEach, describe, expect, it } from "vitest";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { createHop, isForbiddenAddress, parseAuthority } from "./hop-server.js";

/**
 * A CONNECT, spoken by hand.
 *
 * No client library, because the thing under test is what this hop does with a
 * request line — and a library would normalise exactly the malformed shapes
 * worth sending it.
 */
function connectThrough(port: number, authority: string): Promise<{ status: string; socket: ReturnType<typeof connect> }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\r\n\r\n");
      if (end !== -1) resolve({ status: buffer.slice(0, buffer.indexOf("\r\n")), socket });
    });
    // A refusal answers a status line; an *allowed* host whose upstream cannot
    // be dialled gets the socket destroyed with no reply at all. Resolving on
    // close with an empty status is what lets a case assert "not refused"
    // without needing a reachable upstream — which loopback cannot be here,
    // because `isForbiddenAddress` refuses it ahead of the allowlist.
    socket.on("close", () => resolve({ status: buffer.slice(0, Math.max(0, buffer.indexOf("\r\n"))), socket }));
    socket.on("error", reject);
    setTimeout(() => reject(new Error("no reply")), 5_000).unref();
  });
}

const listen = (server: { listen: (p: number, h: string, cb: () => void) => void; address: () => unknown }) =>
  new Promise<number>(resolve =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
  );

let open: { close: (cb?: () => void) => void }[] = [];
afterEach(() => {
  for (const server of open) server.close();
  open = [];
});

describe("parsing a CONNECT authority", () => {
  it("takes host and port", () => {
    expect(parseAuthority("api.github.com:443")).toEqual({ host: "api.github.com", port: 443 });
  });

  it("takes a bracketed IPv6 literal", () => {
    expect(parseAuthority("[2001:db8::1]:443")).toEqual({ host: "[2001:db8::1]", port: 443 });
  });

  // Refused rather than defaulted. A CONNECT with no port is not a request this
  // hop knows how to serve, and picking 443 would be inventing the destination.
  it.each([["api.github.com"], ["api.github.com:"], ["api.github.com:0"], ["api.github.com:99999"], [""]])(
    "refuses %s",
    target => {
      expect(parseAuthority(target)).toBeNull();
    }
  );
});

// The check that sits ahead of the allowlist, for the case an allowlist over
// names structurally cannot see: a listed name that resolves to the metadata
// address.
describe("addresses no sheet may reach", () => {
  it.each([
    ["127.0.0.1"],
    ["127.1.2.3"],
    ["localhost"],
    ["169.254.169.254"],
    ["[::1]"],
    ["::1"],
    ["0.0.0.0"],
    ["[fe80::1]"],
    ["::ffff:169.254.169.254"]
  ])("refuses %s", host => {
    expect(isForbiddenAddress(host)).toBe(true);
  });

  // Deliberately NOT refused. `*.internal.example.com` is the worked example the
  // team-sheet docs ship, and a blanket private-range denial would break the
  // documented case — so the asymmetry is a decision, not an oversight.
  it.each([["10.0.0.5"], ["192.168.1.10"], ["172.16.0.1"], ["api.github.com"], ["build.internal.example.com"]])(
    "allows %s to reach the allowlist",
    host => {
      expect(isForbiddenAddress(host)).toBe(false);
    }
  );
});

describe("the hop", () => {
  // The positive control for every refusal below. Without it, "the host was
  // denied" would also pass on a hop that denies everything — which is a hop
  // that does not work.
  //
  // It asserts the *decision*, not the tunnel: an allowed host gets past both
  // checks and is dialled, and the dial then fails because nothing is listening.
  // The tunnel carrying real bytes is proven in sandbox.docker.test.ts against a
  // real network, which is the only place it can be — loopback is refused ahead
  // of the allowlist, so there is no local upstream this hop will ever dial.
  it("does not refuse a host the list allows", async () => {
    const denied: string[] = [];
    const hop = createHop({ allow: ["upstream.test"], onDenied: host => denied.push(host) });
    const port = await listen(hop);
    open.push(hop);

    const { status, socket } = await connectThrough(port, "upstream.test:1");
    socket.destroy();

    expect(status).not.toContain("403");
    expect(denied).toEqual([]);
  });

  it("refuses a host the list does not allow, and names it", async () => {
    const denied: string[] = [];
    const hop = createHop({ allow: ["api.github.com"], onDenied: host => denied.push(host) });
    const port = await listen(hop);
    open.push(hop);

    const { status, socket } = await connectThrough(port, "evil.example.com:443");
    socket.destroy();

    expect(status).toContain("403");
    // Named before any connection was opened — #219's acceptance in one line.
    expect(denied).toEqual(["evil.example.com"]);
  });

  it("refuses a near miss the matcher is built to catch", async () => {
    const denied: string[] = [];
    const hop = createHop({ allow: ["*.internal.example.com"], onDenied: host => denied.push(host) });
    const port = await listen(hop);
    open.push(hop);

    // The apex, and a suffix-anchored impostor. Both are `isEgressAllowed`'s
    // cases rather than this file's — asserted here to prove the hop asks it.
    for (const host of ["internal.example.com", "evil-internal.example.com", "internal.example.com.attacker.com"]) {
      const { status, socket } = await connectThrough(port, `${host}:443`);
      socket.destroy();
      expect(status).toContain("403");
    }
    expect(denied[0]).toBe("internal.example.com");
  });

  it("refuses the metadata address even when a pattern would admit it", async () => {
    const denied: string[] = [];
    // A list that literally names it. The address check sits ahead of the
    // allowlist precisely so this cannot be granted.
    const hop = createHop({ allow: ["169.254.169.254"], onDenied: host => denied.push(host) });
    const port = await listen(hop);
    open.push(hop);

    const { status, socket } = await connectThrough(port, "169.254.169.254:80");
    socket.destroy();

    expect(status).toContain("403");
    expect(denied).toEqual(["169.254.169.254"]);
  });

  it("refuses everything after the first denial, because the run is over", async () => {
    const denied: string[] = [];
    const hop = createHop({ allow: ["api.github.com"], onDenied: host => denied.push(host) });
    const port = await listen(hop);
    open.push(hop);

    const first = await connectThrough(port, "evil.example.com:443");
    first.socket.destroy();
    const second = await connectThrough(port, "api.github.com:443");
    second.socket.destroy();

    expect(second.status).toContain("403");
    // One denial, not two: the runner is killing the sandbox, and the window
    // between the denial and the kill must not be one where the list is off.
    expect(denied).toEqual(["evil.example.com"]);
  });

  it("refuses an absolute-form request rather than becoming a forward proxy", async () => {
    const hop = createHop({ allow: ["api.github.com"], onDenied: () => {} });
    const port = await listen(hop);
    open.push(hop);

    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port }, () => {
        socket.write("GET http://api.github.com/ HTTP/1.1\r\nHost: api.github.com\r\n\r\n");
      });
      let buffer = "";
      socket.on("data", chunk => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(buffer);
        }
      });
      socket.on("error", reject);
    });

    // 405 rather than 403: serving it would make this a proxy that reads bodies,
    // which is a thing it does not do — not a governance decision.
    expect(reply).toContain("405");
  });
});
