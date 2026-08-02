# @getlibero/proxy-server

Unpublished workspace package. The tool-proxy process: composition only, with
the behavior in [`@getlibero/proxy`](../../packages/proxy). See
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for the specification.

```bash
sh scripts/dev-certs.sh --channels C024BE91L   # from the repo root
pnpm -r build

PROXY_TLS_CERT=deploy/certs/server.pem \
PROXY_TLS_KEY=deploy/certs/server.key \
PROXY_TLS_CA=deploy/certs/ca.pem \
  pnpm --filter @getlibero/proxy-server start
```

| variable | default | |
| --- | --- | --- |
| `PROXY_TLS_CERT` | — | the proxy's own certificate |
| `PROXY_TLS_KEY` | — | its private key |
| `PROXY_TLS_CA` | — | the CA every client certificate is checked against |
| `PROXY_HOST` | `127.0.0.1` | compose sets `0.0.0.0`, on a bridge that publishes no ports |
| `PROXY_PORT` | `8443` | |

The three TLS paths are required. A missing one stops the process at startup
rather than degrading: a proxy that came up without mutual TLS would be
reachable, unauthenticated, and holding every credential in the deployment.
