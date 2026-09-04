# Running the devnet rig

Devnet is the only environment where At Stake can be tested against **real
Bitcoin**. It runs an actual `bitcoind` in regtest with a Stacks node following
it, so `get-burn-block-info?` returns genuine block headers and the burn-header
check runs for real. That check is bypassed in simnet (`SIM-SKIP-HEADER`) and
is untestable on the public PoX-5 testnet, whose burn chain is private and
exposes no Bitcoin RPC.

| environment | Bitcoin | header check |
|---|---|---|
| simnet | none, synthetic burn blocks | bypassed |
| PoX-5 public testnet | private regtest chain, no RPC | real, but unreachable |
| **devnet** | **real bitcoind, yours** | **real** |

## What it costs to run

Seven containers, ~1.6 GB of images. Steady state is roughly 3-4.5 GB of RAM
with the API on, ~2 GB without. A 4 vCPU / 8 GB / 40 GB box is comfortable.
Every image ships `linux/arm64` as well as `amd64`, so an ARM VPS is fine.

## Setup on Ubuntu 24.04 (x86_64)

### 1. Docker Engine

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo usermod -aG docker $USER && newgrp docker   # so docker works without sudo
docker run --rm hello-world                      # verify
```

### 2. Clarinet

```bash
curl -L https://github.com/stx-labs/clarinet/releases/download/v3.23.2/clarinet-linux-x64-glibc.tar.gz \
  | tar -xz
sudo mv clarinet /usr/local/bin/
clarinet --version    # expect 3.23.x
```

Use `clarinet-linux-arm64-glibc.tar.gz` on ARM. The `musl` builds are for Alpine.

### 3. Node 22+ and the repo

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v && npm -v          # npm must be >= 11

git clone https://github.com/aibtcdev/at-stake.git
cd at-stake
npm install                # do NOT add --legacy-peer-deps
npm test                   # 58 passing, proves the checkout is sound
```

If npm is older than 11, `npm install` dies with
`Cannot read properties of null (reading 'edgesOut')`. Use `npx npm@11 install`.

### 4. Start devnet

```bash
clarinet devnet start
```

First run pulls ~1.6 GB of images. It reaches epoch 4.0 at burn height 162
(see `epoch_4_0` in `settings/Devnet.toml`) — that is when pox-5 and Clarity 6
become available, so **wait for burn height 162+** before expecting pox-5 to
answer.

Leave it running. In another shell:

```bash
watch -n5 'curl -s localhost:20443/v2/info | python3 -m json.tool | head -20'
```

## Reaching it from your laptop

The bitcoind credentials are the published devnet defaults (`devnet`/`devnet`),
so **do not open 18443 or 20443 to the internet**. Tunnel instead:

```bash
ssh -N -L 18443:127.0.0.1:18443 -L 20443:127.0.0.1:20443 user@your-vps
```

Then, locally:

```bash
npm run devnet:check
```

That mines to coinbase maturity, pays 1 BTC to a fresh address, confirms it,
and prints a complete SPV proof — the `header`, `merkle-path`, `tx-index`,
`burn-height` and non-witness `snap-tx` that `create-market` takes. It verifies
the merkle root against the block header before printing, so if it succeeds the
Bitcoin half of the pipeline is sound.

Override the endpoint with `BTC_RPC_URL`, `BTC_RPC_USER`, `BTC_RPC_PASS` if you
run it on the VPS directly rather than through a tunnel.

## Two things to know

**Coinbase maturity.** Regtest coinbase outputs need 100 confirmations before
they can be spent, which is why `check.mjs` mines 101 blocks first.

**Non-witness serialization.** A txid is the double-SHA of the *legacy*
encoding. `bitcoind` returns the segwit encoding for segwit transactions, which
hashes to the wtxid and will never match a merkle proof. `build-proof.mjs`
strips the marker, flag and witness stanzas, then asserts the result hashes to
the txid bitcoind reported. If that assert ever fires, the stripper is wrong —
do not work around it.

**Block time** is 10s (`bitcoin_controller_block_time`). Markets are measured in
burn heights, so this is the clock the whole protocol runs on. Lower it for
faster cycles; raise it if the box struggles.
