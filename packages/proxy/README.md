# @getlibero/proxy

Unpublished workspace package. `apps/proxy-server` is the process that composes
it. See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for the
specification.

What is here today is the service floor: mutual TLS, and the rule that decides
which channel a request belongs to.

- `tls.ts` — server options that refuse a client with no certificate the local
  CA signed. `requestCert` and `rejectUnauthorized` together, TLS 1.3 only.
- `identity.ts` — the channel id, read from the client certificate's subject
  (`CN=channel:<id>`) and from nowhere else. No header and no request body is
  consulted, because the process on the other end runs the model.
- `server.ts` — `node:https` and an exact-match route table. `GET /health` and
  `GET /v1/whoami`, both behind mutual TLS.
- `log.ts` — JSON lines over a closed field set. This process holds every
  credential, so there is no free-form log message for one to be interpolated
  into.

Nothing at runtime but `@getlibero/schema`, which fixes the shape of every
error the proxy returns. Deliberate, for the process that holds the secrets.

Still to come, each with its own issue: the credential vault, team-sheet
enforcement on the call path, the approval broker, the budget meter, and the
audit writer.

## Certificates

`scripts/dev-certs.sh` mints the CA, the server certificate, and one client
certificate per channel, laid out by role — `ca.pem` at the root, the proxy's
keypair under `proxy/`, the channel client certs under `agent/` — so each
container mounts only its slice and the CA key is mounted into neither. The
tests run that same script rather than carrying fixtures, so no private key is
committed here and the documented operator path is exercised on every CI run.
It needs `openssl` on PATH.
