#!/usr/bin/env sh
# Mints the mutual-TLS material the two services use: a local CA, the proxy's
# server certificate, and one client certificate per channel.
#
# The channel id lives in the client certificate's subject CN, as
# "channel:<id>". That is the only place the proxy will read a channel identity
# from — there is no header and no body field it will accept — so minting a
# certificate is what grants a channel the ability to call the proxy at all.
#
# Certificates authenticate; team sheets authorize. There is no revocation list
# here on purpose. A channel loses its permissions when its team sheet is
# removed, which is the enforcement path the proxy runs on every call.
#
# The CA is local and operator-owned: it never leaves the host, signs nothing
# but these two roles, and is not a public trust anchor. The keys it produces
# do NOT belong in the git repo that holds your team sheets.
#
# Output is laid out by role so a deployment can mount each container exactly
# what it needs and nothing else — in particular, the CA key is mounted into
# NEITHER container, because a process that can mint certificates can name
# itself any channel:
#   OUT/ca.pem    trust anchor, shared with both containers
#   OUT/ca.key    signs certificates; stays on the host
#   OUT/proxy/    the proxy's server certificate and key
#   OUT/agent/    one client certificate and key per channel
#
# This script is also what the proxy's test suite runs to get its fixtures, so
# the documented path is exercised on every CI run rather than rotting.
set -eu

OUT="deploy/certs"
CHANNELS=""
RAW_CNS=""
DAYS=3650

usage() {
  cat <<'EOF'
usage: sh scripts/dev-certs.sh [--out DIR] [--channels a,b,c] [--raw-cn LABEL=CN]

  --out DIR          where to write the material (default: deploy/certs)
  --channels a,b,c   channel ids to mint client certs for. Defaults to every
                     directory under channels/ except "example".
  --raw-cn LABEL=CN  mint an extra client cert with a verbatim CN, written as
                     agent/client-LABEL.pem. For testing what the proxy rejects
                     and for debugging identity resolution — not for deployment.

Re-running is safe: it overwrites what it wrote before. Adding a channel means
creating its directory and running this again.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --channels) CHANNELS="$2"; shift 2 ;;
    --raw-cn) RAW_CNS="${RAW_CNS}${RAW_CNS:+
}$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "dev-certs: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v openssl >/dev/null 2>&1 || {
  echo "dev-certs: openssl is required and was not found on PATH" >&2
  exit 1
}

# Default to the channels that actually exist. "example" is the documented
# starter sheet, not a channel anyone runs, so it gets no key material.
if [ -z "$CHANNELS" ] && [ -d channels ]; then
  for dir in channels/*/; do
    [ -d "$dir" ] || continue
    id=$(basename "$dir")
    [ "$id" = "example" ] && continue
    CHANNELS="${CHANNELS}${CHANNELS:+,}${id}"
  done
fi

mkdir -p "$OUT/proxy" "$OUT/agent"
EXT="${OUT}/.extensions.cnf"

# Extension sections only. Subjects are passed with -subj instead of being
# named here: the CN is the security-relevant field, and the LibreSSL that
# ships with macOS lets a config file's [dn] silently override -subj.
#
# "proxy" is the compose service name, so the agent container reaches the proxy
# by that hostname; localhost covers running the two processes directly.
cat > "$EXT" <<'EOF'
[v3_ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash

[v3_server]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @server_alt

[v3_client]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = clientAuth

[server_alt]
DNS.1 = proxy
DNS.2 = localhost
IP.1 = 127.0.0.1
IP.2 = ::1
EOF

# openssl's -subj parser splits fields on "/", so a CN that contains one has to
# arrive escaped. Deployment CNs never do; the --raw-cn cases that probe path
# traversal are exactly why this is here.
escape_cn() { printf '%s' "$1" | sed 's#/#\\/#g'; }

csr() { # csr <name> <subject-cn>
  openssl req -new -newkey rsa:2048 -nodes \
    -keyout "${OUT}/${1}.key" -out "${OUT}/${1}.csr" \
    -subj "/CN=$(escape_cn "$2")" 2>/dev/null
  chmod 600 "${OUT}/${1}.key"
}

sign() { # sign <name> <subject-cn> <extension-section>
  csr "$1" "$2"
  openssl x509 -req -in "${OUT}/${1}.csr" \
    -CA "${OUT}/ca.pem" -CAkey "${OUT}/ca.key" -CAcreateserial \
    -out "${OUT}/${1}.pem" -days "$DAYS" -sha256 \
    -extfile "$EXT" -extensions "$3" 2>/dev/null
  rm -f "${OUT}/${1}.csr"
}

echo "dev-certs: certificate authority -> ${OUT}/ca.pem"
csr ca "libero-local-ca"
openssl x509 -req -in "${OUT}/ca.csr" -signkey "${OUT}/ca.key" \
  -out "${OUT}/ca.pem" -days "$DAYS" -sha256 \
  -extfile "$EXT" -extensions v3_ca 2>/dev/null
rm -f "${OUT}/ca.csr"

echo "dev-certs: proxy server cert -> ${OUT}/proxy/server.pem"
sign proxy/server "libero-proxy" v3_server

if [ -z "$CHANNELS" ] && [ -z "$RAW_CNS" ]; then
  echo "dev-certs: no channels found under channels/ — no client certs minted." >&2
  echo "dev-certs: create channels/<CHANNEL_ID>/channel.toml and run this again." >&2
fi

IFS=,
for id in $CHANNELS; do
  [ -n "$id" ] || continue
  echo "dev-certs: client cert for channel ${id} -> ${OUT}/agent/client-${id}.pem"
  sign "agent/client-${id}" "channel:${id}" v3_client
done
unset IFS

# LABEL=CN, split on the first '='. The CN is passed through untouched, which
# is the point: these exist to prove the proxy rejects what it should.
echo "$RAW_CNS" | while IFS= read -r spec; do
  [ -n "$spec" ] || continue
  echo "dev-certs: client cert with raw CN ${spec#*=} -> ${OUT}/agent/client-${spec%%=*}.pem"
  sign "agent/client-${spec%%=*}" "${spec#*=}" v3_client
done

rm -f "$EXT" "${OUT}/ca.srl"

echo "dev-certs: done. Mount ${OUT}/proxy only into the proxy, ${OUT}/agent only"
echo "dev-certs: into the agent, and ${OUT}/ca.key into neither container."
echo "dev-certs: Keep ${OUT} out of the git repo holding your team sheets."
