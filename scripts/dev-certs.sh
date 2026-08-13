#!/usr/bin/env sh
# Mints the mutual-TLS material the two services use: a local CA, the proxy's
# server certificate, and one client certificate per channel.
#
# The channel id lives in the client certificate's subject CN, as
# "channel:<id>". That is the only place the proxy will read a channel identity
# from — there is no header and no body field it will accept — so minting a
# certificate is what lets a channel call the proxy at all.
#
# Certificates authenticate; team sheets authorize. There is still no revocation
# list here, and there is no CRL anywhere in the design: since #79 a sheet names
# the fingerprints of the certificates allowed to speak for its channel, so
# revoking a leaked key is dropping a line from the sheet — the same file, the
# same review, the same git history as every other permission. This script's job
# is to print the fingerprint an operator pastes there; it never writes a sheet.
# Minting material and authorizing it are two acts, and a script that did both
# would hand back the property pinning exists to create.
#
# **Re-running mints only what is missing.** Once a fingerprint is pinned, a
# re-mint of an existing certificate is an outage for that channel, so adding a
# channel no longer disturbs the others. Deliberate replacement is --force, and
# replacing the CA — which invalidates every certificate and every pin in the
# deployment at once — is --force-ca and says so before it does it.
#
# The CA is local and operator-owned: it never leaves the host, signs nothing
# but these two roles, and is not a public trust anchor. The keys it produces
# do NOT belong in the git repo that holds your team sheets.
#
# Output is laid out by role so a deployment can mount each container exactly
# what it needs and nothing else — in particular, the CA key is mounted into
# NEITHER container, because a process that can mint certificates can name
# itself any channel:
#   OUT/ca.pem          trust anchor, shared with both containers
#   OUT/ca.key          signs certificates; stays on the host
#   OUT/ca.srl          the CA's serial counter; stays beside the key
#   OUT/proxy/          the proxy's server certificate and key
#   OUT/agent/          one client certificate and key per channel
#   OUT/agent/staged/   a replacement waiting to be pinned; see --rotate
#
# This script is also what the proxy's test suite runs to get its fixtures, so
# the documented path is exercised on every CI run rather than rotting.
set -eu

OUT="deploy/certs"
CHANNELS_ROOT="channels"
CHANNELS=""
RAW_CNS=""
MODE="mint"
TARGET=""
FORCE=0
FORCE_CA=0

# The CA and the proxy's server certificate are deployment-lifetime material an
# operator replaces by hand. A client certificate is not: it lives in the agent
# container, which is the less-trusted of the two processes and the one whose
# compromise this design is built to survive, so its lifetime is bounded and
# --rotate exists to make renewing it routine. Ten years on a key sitting in
# that container was the exposure #79 was filed about.
CA_DAYS=3650
SERVER_DAYS=3650
CLIENT_DAYS=365

# Warn about a client certificate within thirty days of expiry. A short lifetime
# without a warning is a scheduled outage nobody scheduled.
EXPIRY_WARN_SECONDS=2592000

usage() {
  cat <<'EOF'
usage: sh scripts/dev-certs.sh [--out DIR] [--channels a,b,c] [--raw-cn LABEL=CN]
       sh scripts/dev-certs.sh --print-pins [--out DIR]
       sh scripts/dev-certs.sh --rotate CHANNEL_ID [--out DIR]
       sh scripts/dev-certs.sh --promote CHANNEL_ID [--out DIR]

  --out DIR             where to write the material (default: deploy/certs)
  --channels-root DIR   where team sheets live (default: channels)
  --channels a,b,c      channel ids to mint client certs for. Defaults to every
                        directory under the channels root except "example".
  --raw-cn LABEL=CN     mint an extra client cert with a verbatim CN, written as
                        agent/client-LABEL.pem. For testing what the proxy
                        rejects and for debugging identity resolution — not for
                        deployment.
  --print-pins          print each client certificate's fingerprint and expiry,
                        in the form a team sheet takes. Mints nothing.
  --rotate CHANNEL_ID   mint a replacement into agent/staged/ and print its
                        fingerprint. Nothing in service changes.
  --promote CHANNEL_ID  move the staged material into place. Refuses unless the
                        channel's sheet already pins the staged fingerprint.
  --force               re-mint the certificates the CA signed — the proxy's and
                        every client one — even where they already exist. This
                        stops the fingerprints team sheets pin from matching;
                        --rotate replaces one client certificate without that.
  --force-ca            re-mint the CA, and with it everything it signed.

Re-running mints only what is missing, so adding a channel leaves every other
channel's certificate — and the fingerprint its team sheet pins — untouched.
EOF
}

say() { echo "dev-certs: $*"; }
die() { echo "dev-certs: $*" >&2; exit 1; }

# How this script tells you to run it again.
#
# Standalone that is `sh scripts/dev-certs.sh --rotate ID`, which is what `$0`
# gives. `libero channel` ships a copy of this file inside its npm package and
# drives it, and there `$0` is a path under node_modules that an operator must
# never be told to type — so it sets DEV_CERTS_SELF_CMD to its own spelling and
# the two-step rotation reads as two commands they actually have.
#
# Unset, nothing changes. Every existing caller — the proxy's and the agent's
# test fixtures included — sees exactly what it saw before.
self_cmd() { # self_cmd <rotate|promote> <channel-id>
  if [ -n "${DEV_CERTS_SELF_CMD:-}" ]; then
    printf '%s %s %s' "$DEV_CERTS_SELF_CMD" "$1" "$2"
  else
    printf 'sh %s --%s %s' "$0" "$1" "$2"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --channels-root) CHANNELS_ROOT="$2"; shift 2 ;;
    --channels) CHANNELS="$2"; shift 2 ;;
    --raw-cn) RAW_CNS="${RAW_CNS}${RAW_CNS:+
}$2"; shift 2 ;;
    --print-pins) MODE="print-pins"; shift ;;
    --rotate) MODE="rotate"; TARGET="$2"; shift 2 ;;
    --promote) MODE="promote"; TARGET="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --force-ca) FORCE_CA=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "dev-certs: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v openssl >/dev/null 2>&1 || die "openssl is required and was not found on PATH"

STAGED="${OUT}/agent/staged"
EXT="${OUT}/.extensions.cnf"

# The two things an operator needs about a certificate and cannot get from the
# filename. `fingerprint` prints the colon-separated pairs a team sheet takes;
# it is byte-identical to Node's `fingerprint256`, which is what the proxy
# compares against, so what this prints is what has to be pasted.
fingerprint() { openssl x509 -in "$1" -noout -fingerprint -sha256 | sed 's/^.*=//'; }
expires_on()  { openssl x509 -in "$1" -noout -enddate | sed 's/^notAfter=//'; }

# The line to paste, and the section it goes in. Printed rather than written:
# see the header.
print_pin() { # print_pin <pem>
  say "  expires $(expires_on "$1")"
  say "  [channel] certificate_sha256 = [\"$(fingerprint "$1")\"]"
}

warn_if_expiring() { # warn_if_expiring <label> <pem> [rotate-id]
  openssl x509 -in "$2" -noout -checkend "$EXPIRY_WARN_SECONDS" >/dev/null 2>&1 && return 0
  say "WARNING: $1 expires $(expires_on "$2")."
  [ $# -ge 3 ] && say "WARNING: replace it without an outage: $(self_cmd rotate "$3")"
  return 0
}

write_ext() {
  mkdir -p "$OUT/proxy" "$OUT/agent"
  # Extension sections only. Subjects are passed with -subj instead of being
  # named here: the CN is the security-relevant field, and the LibreSSL that
  # ships with macOS lets a config file's [dn] silently override -subj.
  #
  # "proxy" is the compose service name, so the agent container reaches the
  # proxy by that hostname; localhost covers running the two processes directly.
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
}

cleanup() { rm -f "$EXT"; }
trap cleanup EXIT

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

sign() { # sign <name> <subject-cn> <extension-section> <days>
  require_ca
  csr "$1" "$2"
  openssl x509 -req -in "${OUT}/${1}.csr" \
    -CA "${OUT}/ca.pem" -CAkey "${OUT}/ca.key" -CAcreateserial \
    -out "${OUT}/${1}.pem" -days "$4" -sha256 \
    -extfile "$EXT" -extensions "$3" 2>/dev/null
  rm -f "${OUT}/${1}.csr"
}

# The CA has to exist and be usable before anything can be signed against it.
# `ca.pem` without `ca.key` is the posture where the key was moved off the host
# on purpose, so it is named rather than left to openssl's error.
require_ca() {
  [ -f "${OUT}/ca.pem" ] || die "no certificate authority at ${OUT}/ca.pem. Run this script with no arguments first."
  [ -f "${OUT}/ca.key" ] || die "${OUT}/ca.pem exists but ${OUT}/ca.key does not — nothing here can sign. Restore the CA key or sign on the host that holds it."
}

case "$MODE" in
  print-pins)
    [ -d "${OUT}/agent" ] || die "no client certificates under ${OUT}/agent"
    for pem in "${OUT}"/agent/client-*.pem; do
      [ -f "$pem" ] || continue
      label=$(basename "$pem" .pem); label=${label#client-}
      say "channel ${label} -> ${pem}"
      print_pin "$pem"
      warn_if_expiring "channel ${label}" "$pem" "$label"
    done
    exit 0
    ;;

  rotate)
    [ -n "$TARGET" ] || die "--rotate needs a channel id"
    require_ca
    write_ext
    mkdir -p "$STAGED"
    say "staged replacement for channel ${TARGET} -> ${STAGED}/client-${TARGET}.pem"
    sign "agent/staged/client-${TARGET}" "channel:${TARGET}" v3_client "$CLIENT_DAYS"
    print_pin "${STAGED}/client-${TARGET}.pem"
    say ""
    say "Nothing in service has changed. Add that fingerprint to"
    say "  ${CHANNELS_ROOT}/${TARGET}/channel.toml"
    say "alongside the one already there — both certificates are then accepted —"
    say "and then run: $(self_cmd promote "$TARGET")"
    exit 0
    ;;

  promote)
    [ -n "$TARGET" ] || die "--promote needs a channel id"
    staged_pem="${STAGED}/client-${TARGET}.pem"
    staged_key="${STAGED}/client-${TARGET}.key"
    [ -f "$staged_pem" ] && [ -f "$staged_key" ] ||
      die "nothing staged for channel ${TARGET}. Run: $(self_cmd rotate "$TARGET")"

    fp=$(fingerprint "$staged_pem")
    sheet="${CHANNELS_ROOT}/${TARGET}/channel.toml"
    if [ "$FORCE" -eq 0 ]; then
      # The ordering guard, and the reason this subcommand exists rather than a
      # line in a runbook. Promoting before the sheet pins the new fingerprint
      # takes the channel offline immediately, and the symptom is a bare 401
      # with nothing on screen connecting it to a rotation. Both written forms
      # of a fingerprint are accepted in a sheet, so both are looked for here.
      bare=$(printf '%s' "$fp" | tr -d ':')
      [ -f "$sheet" ] || die "cannot read ${sheet}, so cannot confirm the new fingerprint is pinned. Pass --force to promote anyway."
      grep -qiE "${fp}|${bare}" "$sheet" ||
        die "${sheet} does not pin the staged fingerprint yet:
  certificate_sha256 = [\"${fp}\"]
Add it beside the current one — both are then accepted — and run this again.
Promoting first would take channel ${TARGET} offline. Pass --force to override."
    fi

    # Key first, certificate last. The agent watches the certificate and reloads
    # both when it changes, so this order is what stops it ever pairing a new
    # certificate with the key it replaced. Each mv is a rename within one
    # directory, so neither file is ever half-written.
    mv "$staged_key" "${OUT}/agent/client-${TARGET}.key"
    mv "$staged_pem" "${OUT}/agent/client-${TARGET}.pem"
    say "channel ${TARGET} now presents ${fp}"
    say "The agent picks this up on its next request; neither service needs a restart."
    say "Drop the old fingerprint from ${sheet} once you have seen a call succeed."
    exit 0
    ;;
esac

# Default to the channels that actually exist. "example" is the documented
# starter sheet, not a channel anyone runs, so it gets no key material.
if [ -z "$CHANNELS" ] && [ -d "$CHANNELS_ROOT" ]; then
  for dir in "$CHANNELS_ROOT"/*/; do
    [ -d "$dir" ] || continue
    id=$(basename "$dir")
    [ "$id" = "example" ] && continue
    CHANNELS="${CHANNELS}${CHANNELS:+,}${id}"
  done
fi

write_ext

if [ -f "${OUT}/ca.pem" ] && [ "$FORCE_CA" -eq 0 ]; then
  # No `require_ca` here: a deployment that has minted everything it needs and
  # moved the CA key off the host is a posture worth supporting, and it is
  # `sign` that cannot proceed without the key, not this branch.
  say "certificate authority ${OUT}/ca.pem exists — kept."
else
  if [ -f "${OUT}/ca.pem" ]; then
    say "re-minting the certificate authority. Every certificate it signed stops"
    say "verifying, and every fingerprint pinned in a team sheet stops matching."
    rm -f "${OUT}/ca.srl"
  fi
  say "certificate authority -> ${OUT}/ca.pem"
  csr ca "libero-local-ca"
  openssl x509 -req -in "${OUT}/ca.csr" -signkey "${OUT}/ca.key" \
    -out "${OUT}/ca.pem" -days "$CA_DAYS" -sha256 \
    -extfile "$EXT" -extensions v3_ca 2>/dev/null
  rm -f "${OUT}/ca.csr"
  # Everything below is signed by a CA that no longer exists, so it is replaced
  # whether or not --force was passed.
  FORCE=1
fi

if [ -f "${OUT}/proxy/server.pem" ] && [ "$FORCE" -eq 0 ]; then
  say "proxy server cert ${OUT}/proxy/server.pem exists — kept."
  warn_if_expiring "the proxy server certificate" "${OUT}/proxy/server.pem"
else
  require_ca
  say "proxy server cert -> ${OUT}/proxy/server.pem"
  sign proxy/server "libero-proxy" v3_server "$SERVER_DAYS"
fi

if [ -z "$CHANNELS" ] && [ -z "$RAW_CNS" ]; then
  echo "dev-certs: no channels found under ${CHANNELS_ROOT}/ — no client certs minted." >&2
  echo "dev-certs: create ${CHANNELS_ROOT}/<CHANNEL_ID>/channel.toml and run this again." >&2
fi

mint_client() { # mint_client <file-stem> <subject-cn> <label> [rotate-id]
  pem="${OUT}/${1}.pem"
  if [ -f "$pem" ] && [ "$FORCE" -eq 0 ]; then
    say "client cert for ${3} exists — kept. Re-minting it would stop the fingerprint its team sheet pins from matching; --rotate replaces it without an outage."
    warn_if_expiring "$3" "$pem" ${4:+"$4"}
    return 0
  fi
  # Before the line announcing it, so a run that cannot sign does not first
  # claim it wrote a file.
  require_ca
  say "client cert for ${3} -> ${pem}"
  sign "$1" "$2" v3_client "$CLIENT_DAYS"
  print_pin "$pem"
}

# Split the comma-separated list once, then restore IFS: everything below runs
# with the default, including `say`, whose "$*" would otherwise join on a comma.
IFS=,
# shellcheck disable=SC2086
set -- $CHANNELS
unset IFS
for id in "$@"; do
  [ -n "$id" ] || continue
  mint_client "agent/client-${id}" "channel:${id}" "channel ${id}" "$id"
done

# LABEL=CN, split on the first '='. The CN is passed through untouched, which
# is the point: these exist to prove the proxy rejects what it should.
echo "$RAW_CNS" | while IFS= read -r spec; do
  [ -n "$spec" ] || continue
  mint_client "agent/client-${spec%%=*}" "${spec#*=}" "raw CN ${spec#*=}"
done

say "done. Mount ${OUT}/proxy only into the proxy, ${OUT}/agent only"
say "into the agent, and ${OUT}/ca.key into neither container."
say "Keep ${OUT} out of the git repo holding your team sheets."
