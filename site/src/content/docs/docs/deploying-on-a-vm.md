---
title: Deploying on a VM
description: The compose stack on a Compute Engine or EC2 instance — one disk, secrets from the platform's secret manager, snapshots as the backup story.
---

[Self-hosting](/docs/self-hosting/) documents the compose stack. This page puts that stack on a
machine that is not a laptop: one VM on GCP or AWS, every piece of durable state on one disk, the
four secrets in the platform's secret manager rather than in a file the snapshot story then copies
around, and disk snapshots as the backup.

:::caution[Read the self-hosting page first]
Everything the caution at the top of [self-hosting](/docs/self-hosting/) says still applies —
certificate rotation is manual, and this is pre-1.0. Standing the stack on a cloud VM does not
change what is finished. Point it at a scratch workspace before a real one.
:::

## The supported shape

**Single node, restart as recovery.** One VM, two containers, one disk. No replication, no
failover, no second instance anywhere. That is a posture rather than a gap: it is what the design
supports today, and the reason it is workable is that a restart costs very little and everything it
costs is on the safe side.

What a restart costs, exactly:

- **Pending approvals expire rather than execute.** The approval broker's ticket store is in memory
  on purpose. A restart drops every pending ticket, so cards already in a channel go stale and the
  calls behind them never run. Nothing is served unapproved — the failure mode of losing that state
  is the safe one.
- **At most one in-flight turn's spend goes unreported.** `SIGTERM` cancels every running task and
  the process then waits eight seconds for the cancelled tasks to report their last turn's spend and
  repaint their checklist cards. `stop_grace_period: 20s` in the compose file exists to leave that
  drain room, because Docker's ten-second default does not. On a clean stop the spend is reported;
  on a power loss it is not, and the daily meter is that much under for that channel that day.
- **Nothing else.** The vault, the budget meter, the audit log and the per-channel message stores are
  all files on the disk. They come back as they were.

An in-flight task is bounded by the channel's `max_task_seconds` — five minutes by default — and
shutdown does not wait for it. A deploy is: stop, pull, start.

## Why not Cloud Run, Fargate, or App Runner

Two structural reasons, neither of them about scale.

**Every piece of durable state lives on a local disk, and most of it is SQLite in WAL mode.** The
budget meter, the audit log, and one message store per channel are SQLite; the vault and the token
store are encrypted files replaced atomically. The volume options those platforms offer are
network filesystems — GCS FUSE, EFS, Filestore NFS — and SQLite over them is a documented corruption
path: its locking assumes a filesystem that implements POSIX advisory locks faithfully, and these
either do not or do so partially. The thing that gets corrupted is the audit log, which is the one
file in the deployment whose whole value is that it is trustworthy.

**The gateway is a long-lived Socket Mode daemon, not a request handler.** It dials out to Slack and
holds the connection open; there is no inbound request to scale on and no URL to route to. A
platform that scales to zero disconnects it, and a platform that runs two instances of a revision
opens two sockets — every Slack event delivered twice and answered twice. Neither is a tuning
problem.

The proxy is the same shape from the other side: it holds the decrypted vault in memory and re-reads
each channel's team sheet from a mounted directory on every call. A process with a disk, not a
request handler.

There are no Kubernetes manifests either, and not because it cannot be done — because what they
would deploy is still one pod with one volume, with more machinery in front of it. When a real
deployment needs the machinery, that is the issue to open.

## The machine and its disk

| | minimum | comfortable |
| --- | --- | --- |
| CPU and memory | 2 vCPU, 2 GB | 2 vCPU, 4 GB |
| GCP | `e2-small` | `e2-medium` |
| AWS | `t3.small` | `t3.medium` |
| Data disk | 20 GB | 50 GB |

Memory is what the proxy's own bounds multiply out to. `PROXY_MAX_RESPONSE_BYTES` is 4 MiB, an
upstream answer costs three to five times that while it is being decoded, redacted and parsed, and
`PROXY_MAX_UPSTREAM_CONCURRENCY` is 8 — so the worst case against one misbehaving upstream is
roughly 100–160 MB of buffers before Node's own baseline, and the agent holds a transcript per
concurrent task on top. 2 GB runs it with little room; 4 GB is the number to pick if you would
rather not count. Burstable families are fine — the work is mostly waiting on a model.

Disk is the audit log plus the message stores. The audit log is about 200 bytes a row, so 10,000
tool calls a day is about 2 MB a day, and it is never pruned — there is no retention command and
there should not be one. The message stores grow with what people say in the channels the agent is
in. 20 GB is a long time; 50 GB is not having to think about it.

### One disk, and everything durable on it

The boot disk is disposable. Attach a second disk, mount it at `/opt/libero`, and put both halves of
the deployment's state on it:

```
/opt/libero
├── libero/     the checkout: channels/, deploy/certs, the compose file
└── docker/     Docker's data-root: the vault, budget, audit and store volumes
```

The four named volumes in `deploy/docker-compose.yml` live under Docker's data root, so moving that
root is how they land on this disk without touching the compose file. The host-authored half — team
sheets and the certificates that speak for each channel — is the checkout beside it.

One disk rather than two because a snapshot is per-disk and point-in-time. Everything the deployment
would need to come back is captured in one image taken at one instant, and a snapshot taken at that
granularity is exactly the event SQLite's WAL is built to survive: it looks like a power loss, and
committed transactions are there. Two disks would be two images taken at two moments, with the team
sheets and the audit log of a call they authorized potentially from either side of an edit.

### No inbound ports

Neither service publishes one. The gateway dials out to Slack, and the proxy listens only on the
private compose bridge. The instance needs **egress** — Slack, the model provider, `ghcr.io`, and
whatever upstreams your team sheets name — and **no ingress rule for the deployment at all**.

Administrative access does not need one either: IAP TCP forwarding on GCP and Session Manager on
AWS both reach a shell without an open SSH port, and both put IAM in front of it.

## Provisioning

Pick your cloud. Both sections end with a shell on the instance and four empty secrets waiting for
values; [preparing the host](#preparing-the-host) onward is the same for both.

### GCP

```bash
PROJECT=libero-prod
REGION=us-central1
ZONE=us-central1-a

gcloud config set project "$PROJECT"
gcloud services enable compute.googleapis.com secretmanager.googleapis.com iap.googleapis.com
```

**A service account for the instance.** The VM's identity should be able to read four secrets and do
nothing else, so it gets its own account rather than the default one:

```bash
gcloud iam service-accounts create libero-vm --display-name "Libero VM"
SA="libero-vm@$PROJECT.iam.gserviceaccount.com"
```

**The four secrets, created empty.** The values are added from the instance in
[secrets, and where they are not](#secrets-and-where-they-are-not); creating the containers here is
what lets the instance's own identity add a version without ever holding permission to create,
list, or read anything else in the project:

```bash
for s in slack-app-token slack-bot-token provider-key vault-key; do
  gcloud secrets create "libero-$s" --replication-policy=automatic
  gcloud secrets add-iam-policy-binding "libero-$s" \
    --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
  gcloud secrets add-iam-policy-binding "libero-$s" \
    --member="serviceAccount:$SA" --role=roles/secretmanager.secretVersionAdder
done
```

`secretVersionAdder` is for setup. [Drop it](#dropping-the-write-permission) once the four values are
in — the running deployment only reads.

**A network with no ingress rules.** The auto-created `default` network carries
`default-allow-ssh` from `0.0.0.0/0`, so the deployment gets a network of its own instead. A network
created this way has no firewall rules at all, and the one rule added below is the only ingress in
the deployment: from IAP's range, on port 22, with IAM deciding who gets through it.

```bash
gcloud compute networks create libero --subnet-mode=auto
gcloud compute firewall-rules create libero-iap-ssh \
  --network=libero --allow=tcp:22 --source-ranges=35.235.240.0/20
```

**The instance and its data disk:**

```bash
gcloud compute instances create libero \
  --zone="$ZONE" \
  --machine-type=e2-medium \
  --network=libero --subnet=libero \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=20GB --boot-disk-type=pd-balanced \
  --create-disk=name=libero-data,size=50GB,type=pd-balanced,auto-delete=no,device-name=libero-data \
  --service-account="$SA" --scopes=cloud-platform \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --metadata=enable-oslogin=TRUE
```

`auto-delete=no` is the line that makes the data disk outlive the instance, which is what
[restore](#backups-and-restore) depends on. The instance keeps an ephemeral external address for
egress; nothing can reach it, because the network has no ingress rule beyond IAP's. If you would
rather it had no address at all, add `--no-address` and a Cloud NAT gateway in the region — same
deployment, one more billed resource.

**A shell**, which needs `roles/iap.tunnelResourceAccessor` (a project owner has it):

```bash
gcloud compute ssh libero --zone="$ZONE" --tunnel-through-iap
```

Continue at [preparing the host](#preparing-the-host).

### AWS

```bash
REGION=us-east-1
export AWS_DEFAULT_REGION="$REGION"

VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' --output text)
SUBNET=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" \
  --query 'Subnets[0].SubnetId' --output text)
AZ=$(aws ec2 describe-subnets --subnet-ids "$SUBNET" \
  --query 'Subnets[0].AvailabilityZone' --output text)
```

The default VPC is used as it comes, because unlike GCP's default network it ships no rule that
admits the internet — a security group with no ingress rules is the whole of it.

**The four secrets, created with a placeholder.** `create-secret` will not create a secret with no
value, so the containers get one that is never read — the real values are put from the instance in
[secrets, and where they are not](#secrets-and-where-they-are-not), and the fetch script reads
whichever version is current:

```bash
for s in slack-app-token slack-bot-token provider-key vault-key; do
  aws secretsmanager create-secret --name "libero/$s" --secret-string placeholder
done
```

Secrets Manager bills per secret per month. If that matters at this size, SSM Parameter Store
`SecureString` parameters are the free equivalent and change one line of the fetch script below;
everything else on this page is the same.

**An instance role that can read those four and be reached by Session Manager:**

```bash
cat > /tmp/trust.json <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
 "Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}
JSON

aws iam create-role --role-name libero-vm \
  --assume-role-policy-document file:///tmp/trust.json
aws iam attach-role-policy --role-name libero-vm \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
cat > /tmp/secrets.json <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
 "Action":["secretsmanager:GetSecretValue","secretsmanager:PutSecretValue"],
 "Resource":"arn:aws:secretsmanager:$REGION:$ACCOUNT:secret:libero/*"}]}
JSON

aws iam put-role-policy --role-name libero-vm \
  --policy-name libero-secrets --policy-document file:///tmp/secrets.json
aws iam create-instance-profile --instance-profile-name libero-vm
aws iam add-role-to-instance-profile --instance-profile-name libero-vm --role-name libero-vm
```

`PutSecretValue` is for setup. [Drop it](#dropping-the-write-permission) once the four values are
in.

**A security group with no ingress rules** — created and then left alone, because that is what
"no inbound ports" is:

```bash
SG=$(aws ec2 create-security-group --group-name libero --description "Libero" \
  --vpc-id "$VPC" --query GroupId --output text)
```

**The volume and the instance:**

```bash
VOL=$(aws ec2 create-volume --availability-zone "$AZ" --size 50 --volume-type gp3 \
  --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=libero-data}]' \
  --query VolumeId --output text)

AMI=$(aws ssm get-parameter \
  --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query Parameter.Value --output text)

INSTANCE=$(aws ec2 run-instances --image-id "$AMI" --instance-type t3.medium \
  --subnet-id "$SUBNET" --security-group-ids "$SG" \
  --associate-public-ip-address \
  --iam-instance-profile Name=libero-vm \
  --metadata-options 'HttpTokens=required,HttpEndpoint=enabled' \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=20,VolumeType=gp3}' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=libero}]' \
  --query 'Instances[0].InstanceId' --output text)

aws ec2 wait instance-running --instance-ids "$INSTANCE"
aws ec2 attach-volume --volume-id "$VOL" --instance-id "$INSTANCE" --device /dev/sdf
```

The data volume is created separately rather than in the block-device mapping so that it outlives
the instance, which is what [restore](#backups-and-restore) depends on. The public address is for
egress; the security group admits nothing. If you would rather it had no address, drop
`--associate-public-ip-address` and add either a NAT gateway or the three SSM interface endpoints —
same deployment, more billed resources.

**A shell**, which needs the Session Manager plugin installed locally:

```bash
aws ssm start-session --target "$INSTANCE"
```

Continue below.

## Preparing the host

The rest of this page is the same on both clouds. Everything here runs on the instance.

**The data disk.** Find it with `lsblk` — it is the one with no partitions, `/dev/sdb` on GCP and
something like `/dev/nvme1n1` on AWS. It gets a filesystem label so that `/etc/fstab` names the
filesystem rather than a device node that renumbers:

```bash
sudo mkfs.ext4 -L libero /dev/nvme1n1        # or /dev/sdb — check lsblk first
echo 'LABEL=libero /opt/libero ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
sudo mkdir -p /opt/libero && sudo mount /opt/libero
```

**Docker, with its data root on that disk.** The data root has to move before anything is pulled,
or the images and volumes land on the boot disk and the snapshot story misses them:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo tee /etc/apt/keyrings/docker.asc > /dev/null
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

sudo systemctl stop docker
sudo mkdir -p /opt/libero/docker
printf '{ "data-root": "/opt/libero/docker" }\n' | sudo tee /etc/docker/daemon.json
sudo systemctl start docker
docker info --format '{{.DockerRootDir}}'    # -> /opt/libero/docker
```

**Node 24 on the host**, for `@getlibero/cli`. The two services carry their own runtime in their
containers; this is about the host, where `libero channel add` mints certificates and `libero
doctor` reads the wiring back:

```bash
sudo snap install node --classic --channel=24
```

Install the cloud CLI the fetch script will call, if it is not already there —
`sudo snap install google-cloud-cli --classic` on GCP, `sudo snap install aws-cli --classic` on AWS.
Both authenticate as the instance's own identity from the metadata service, with nothing to
configure.

**The checkout:**

```bash
sudo chown "$USER" /opt/libero
git clone https://github.com/getlibero/libero /opt/libero/libero
cd /opt/libero/libero
```

## Secrets, and where they are not

Four values are secret: the two Slack tokens, the model provider key, and `PROXY_VAULT_KEY`, the
master key the credential vault is encrypted under. On a laptop they live in `deploy/.env`. Here
they do not live on the disk at all — because the disk is snapshotted, snapshots are copied, and a
copied snapshot is a copied master key.

The shape is: **`deploy/.env` on disk holds the non-secret half, the secret manager holds the four,
and a systemd unit assembles the whole file into `/run` — which is tmpfs, so it is in RAM and never
in a snapshot — before it starts the stack.**

### Writing the non-secret half

`libero init` generates the master key, so run it against a path in RAM and split the result. The
key never touches the disk:

```bash
mkdir -m 700 /dev/shm/libero-init
npx @getlibero/cli init --file /dev/shm/libero-init/.env --model claude-sonnet-4-6
```

Everything but the four goes to `deploy/.env`:

```bash
grep -v -E '^(SLACK_APP_TOKEN|SLACK_BOT_TOKEN|ANTHROPIC_API_KEY|PROXY_VAULT_KEY)=' \
  /dev/shm/libero-init/.env > deploy/.env
```

and the generated key goes straight to the secret manager:

```bash
# GCP
printf %s "$(sed -n 's/^PROXY_VAULT_KEY=//p' /dev/shm/libero-init/.env)" \
  | gcloud secrets versions add libero-vault-key --data-file=-

# AWS
printf %s "$(sed -n 's/^PROXY_VAULT_KEY=//p' /dev/shm/libero-init/.env)" \
  | aws secretsmanager put-secret-value --secret-id libero/vault-key \
      --secret-string file:///dev/stdin

rm -rf /dev/shm/libero-init
```

`printf %s` rather than `echo`, because neither secret manager trims what you give it: a trailing
newline is stored, comes back on every read, and lands in the middle of the assembled environment
file. (`vault set` inside the proxy container does trim exactly one, which is why the self-hosting
page can pipe a file into it.)

:::caution[Do not re-run `libero init` on this host]
`deploy/.env` is now missing those four variables, and a re-run appends what it finds absent —
including a **new** `PROXY_VAULT_KEY`. There is no escrow and no recovery: a vault encrypted under
the old key would be unreadable. The file is complete as it stands.
:::

### Adding the three you have

The Slack app and bot tokens come from the app you created from
[`deploy/slack-app-manifest.yml`](/docs/self-hosting#creating-it); the provider key from your model
provider. Read them over stdin rather than typing them as arguments, for the reason `vault set`
does: `ps` shows arguments to every user on the box and a shell writes them to history.

```bash
# GCP
for s in slack-app-token slack-bot-token provider-key; do
  printf 'value for %s: ' "$s"; read -rs v; echo
  printf %s "$v" | gcloud secrets versions add "libero-$s" --data-file=-
done; unset v

# AWS
for s in slack-app-token slack-bot-token provider-key; do
  printf 'value for %s: ' "$s"; read -rs v; echo
  printf %s "$v" | aws secretsmanager put-secret-value --secret-id "libero/$s" \
    --secret-string file:///dev/stdin
done; unset v
```

### Assembling the environment in RAM

Two scripts and a unit. The first assembles the file, the second is the `docker compose` invocation
with the flags already on it so nothing has to be retyped:

```bash
sudo tee /usr/local/bin/libero-secrets > /dev/null <<'SH'
#!/bin/sh
# Assembles the environment Compose reads, in RAM. /run is tmpfs, so this file
# is never on the persistent disk and never in a snapshot. systemd creates the
# directory at 0700 and removes it when the unit stops.
set -eu
umask 077
out=/run/libero/.env

# The non-secret half, as `libero init` wrote it.
cat /opt/libero/libero/deploy/.env > "$out"

# The four the secret manager holds. Use OPENAI_API_KEY in place of
# ANTHROPIC_API_KEY when AGENT_PROVIDER is openai-compatible.
set -- \
  SLACK_APP_TOKEN:libero-slack-app-token \
  SLACK_BOT_TOKEN:libero-slack-bot-token \
  ANTHROPIC_API_KEY:libero-provider-key \
  PROXY_VAULT_KEY:libero-vault-key
for pair; do
  printf '%s=%s\n' "${pair%%:*}" \
    "$(/snap/bin/gcloud secrets versions access latest --secret="${pair#*:}")" >> "$out"
done
SH
sudo chmod 0755 /usr/local/bin/libero-secrets
```

On AWS the pairs name `libero/slack-app-token` and so on, and the one line that reads a value is:

```sh
  "$(/snap/bin/aws secretsmanager get-secret-value --secret-id "${pair#*:}" \
       --query SecretString --output text)"
```

Absolute paths because systemd's `PATH` does not include `/snap/bin`. The `$( … )` around the read
strips the trailing newline the CLI prints, which is why nothing has to trim here.

Values are written unquoted. That is correct for these four — Slack tokens, provider keys and a
base64 master key contain no `$`, `#`, or newline. A credential that did would need quoting, and
does not belong in this file anyway: tool credentials go in the vault.

```bash
sudo tee /usr/local/bin/libero-compose > /dev/null <<'SH'
#!/bin/sh
exec docker compose \
  -f /opt/libero/libero/deploy/docker-compose.yml \
  --env-file /run/libero/.env "$@"
SH
sudo chmod 0755 /usr/local/bin/libero-compose

sudo tee /etc/systemd/system/libero.service > /dev/null <<'UNIT'
[Unit]
Description=Libero
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
RuntimeDirectory=libero
RuntimeDirectoryMode=0700
ExecStartPre=/usr/local/bin/libero-secrets
ExecStart=/usr/local/bin/libero-compose up -d
ExecStop=/usr/local/bin/libero-compose down

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
```

`RuntimeDirectory=libero` is what creates `/run/libero` at `0700` on start and removes it on stop, so
the assembled file exists exactly as long as the deployment is up. The stack survives a reboot
because the unit is enabled and the services carry `restart: unless-stopped`.

### Dropping the write permission

Once the four values are in, take the write permission away. The running deployment only reads:

```bash
# GCP
for s in slack-app-token slack-bot-token provider-key vault-key; do
  gcloud secrets remove-iam-policy-binding "libero-$s" \
    --member="serviceAccount:$SA" --role=roles/secretmanager.secretVersionAdder
done

# AWS — re-put the inline policy with GetSecretValue only
aws iam put-role-policy --role-name libero-vm --policy-name libero-secrets \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",
   \"Action\":\"secretsmanager:GetSecretValue\",
   \"Resource\":\"arn:aws:secretsmanager:$REGION:$ACCOUNT:secret:libero/*\"}]}"
```

## Bringing it up

**A channel.** One team sheet and one certificate, per channel the agent will serve:

```bash
cd /opt/libero/libero
npx @getlibero/cli channel add C024BE91L --name engineering
```

The sheet it writes grants nothing — the channel authenticates and can call nothing until you add a
block to `channels/C024BE91L/channel.toml`. See the [team sheet reference](/docs/team-sheet/).

**Pull the images.** Both are published to GHCR on every release since v0.3.0, multi-arch
(`amd64`/`arm64`) and carrying build provenance attestations — `deploy/README.md` has the verify
command. Without this step the first `up` builds them from the checkout instead; that works, but the
pull is what makes the instance run the exact bytes a release published:

```bash
libero-compose pull
```

**Start it:**

```bash
sudo systemctl enable --now libero
libero-compose ps
libero-compose logs -f server
```

**Check the wiring.** `doctor` reads an environment file; point it at the assembled one, which is
the file the deployment is actually running on:

```bash
npx @getlibero/cli doctor --file /run/libero/.env
```

All ten assignments are present there, so the environment checks pass or fail on their merits rather
than reporting the four as empty. Every certificate-and-pin check runs against the checkout as
usual. The mutual-TLS probe is skipped, because the proxy publishes no port to the host — the
`/v1/whoami` command in [self-hosting](/docs/self-hosting#pinning-a-channels-certificate) is how you
run it from inside the compose network.

**Tool credentials go into the vault from inside the proxy container**, where the master key already
is — never into the environment file, and never into the secret manager alongside it:

```bash
libero-compose run --rm proxy node dist/vault.js set github_service_account < token.txt
libero-compose run --rm proxy node dist/vault.js list        # names only
```

Then invite the app to the channel and mention it. [Connecting GitHub](/docs/github/) walks the
first real tool call the rest of the way.

Everything else in [operating it](/docs/self-hosting#operating-it) works here with `libero-compose`
in place of the long `docker compose -f …` line — the audit log, the budget meter, and the OAuth
grant flow, which completes in a browser on any machine and needs nothing open on this one.

## Backups and restore

The backup is a snapshot of the one data disk. It contains the team sheets, the certificates, the
vault file, the budget meter, the audit log and every channel's message store — everything the
deployment would need, and no secret from the secret manager.

Take snapshots on the running machine. A snapshot is point-in-time for the disk, which looks to
SQLite exactly like a power loss, and that is the event WAL mode is designed to survive: committed
transactions are in the image and the files are not corrupt. For a snapshot with nothing in flight
at all, `sudo systemctl stop libero` first — a few seconds of downtime, and the drain reports the
last turn's spend on the way out.

**GCP** — a schedule attached to the disk:

```bash
gcloud compute resource-policies create snapshot-schedule libero-daily \
  --region="$REGION" --max-retention-days=30 --start-time=04:00 \
  --daily-schedule --on-source-disk-delete=keep-auto-snapshots
gcloud compute disks add-resource-policies libero-data \
  --resource-policies=libero-daily --zone="$ZONE"
```

Restore: `gcloud compute disks create libero-data-restored --source-snapshot=SNAPSHOT
--zone="$ZONE"`, attach it to a fresh instance, and repeat [preparing the
host](#preparing-the-host) without the `mkfs` — the filesystem label comes back with the snapshot.
Attach it to a *new* instance rather than beside the original, or two filesystems answer to
`LABEL=libero`.

**AWS** — one snapshot is a command; scheduling is a service:

```bash
aws ec2 create-snapshot --volume-id "$VOL" --description "libero $(date -u +%F)"
```

Put it on a schedule with Data Lifecycle Manager or AWS Backup, both of which select the volume by
tag and need nothing installed on the instance. Restore is `aws ec2 create-volume --snapshot-id
SNAPSHOT --availability-zone "$AZ"`, attached to a fresh instance, then the same steps without the
`mkfs`.

**The one thing a snapshot does not contain is the vault master key**, and that is the point of
putting it in the secret manager. It also means the snapshot is worthless without that key: a
restored disk carries the encrypted vault, and only `libero-vault-key` opens it. There is no escrow
and no recovery path. Do not delete that secret, and do not let a cleanup script decide it is
unused.

## Upgrading

Pin image tags in a compose override rather than tracking `latest`, and move them deliberately — the
proxy is a security boundary and you should know when it changes. The upgrade itself is the restart
this page opened with:

```bash
cd /opt/libero/libero && git pull
libero-compose pull
sudo systemctl restart libero
```

Pending approvals expire, in-flight tasks are cancelled and report their last turn's spend, and
everything on disk comes back as it was.
