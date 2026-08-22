# Watermarks Remover — VPS Deployment Guide

Complete, copy-paste deployment for the full stack (core service + dashboard
backend + dashboard UI) on an Ubuntu VPS behind Nginx + Let's Encrypt HTTPS.

- **Target host / domain:** `aiagent.sciencedomain.info`
- **Target OS:** Ubuntu 24.04 LTS (works on 22.04 too)
- **Target hardware:** CPU-only VPS (2 vCPU / 4 GB RAM minimum recommended)
- **Admin credentials on first boot:** `adminai` / `Admin#Ai#2026*`
  (you can change the password from inside the dashboard)

Everything below assumes you're logged in as a sudo-enabled user (not root).

---

## 0. Before you start

You need:

1. A VPS with a public IPv4 address.
2. DNS: an **A record** for `aiagent.sciencedomain.info` pointing at the
   VPS's public IP. Verify with `dig +short aiagent.sciencedomain.info` from
   your laptop — it must return the VPS IP before you request an SSL cert.
3. Ports **22 / 80 / 443** open in the VPS firewall / provider console.

---

## 1. Prepare the server

```bash
# Update the OS
sudo apt update && sudo apt -y upgrade

# Essentials
sudo apt -y install ca-certificates curl gnupg lsb-release git ufw

# Basic firewall
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'   # opens 80 + 443
sudo ufw --force enable
```

---

## 2. Install Docker Engine + Compose plugin

```bash
# Docker's official convenience script (idempotent)
curl -fsSL https://get.docker.com | sudo sh

# Let your user run docker without sudo (log out + back in for it to take effect)
sudo usermod -aG docker "$USER"

# Verify
docker --version
docker compose version
```

**Log out and back in** now so the group change applies.

---

## 3. Clone the repo

```bash
sudo mkdir -p /opt/watermarks-remover
sudo chown -R "$USER":"$USER" /opt/watermarks-remover
cd /opt/watermarks-remover

git clone https://github.com/guillaumemeyer/watermarks-remover.git .

# (optional) Pin to the tag you're deploying, e.g.:
# git checkout v0.5.0
```

> If you're deploying this dashboard fork specifically, replace the URL with
> your own fork and skip the checkout step.

---

## 4. Configure the `.env`

```bash
cp .env.production.example .env
```

Now generate the two secrets and paste them in:

```bash
# API key shared between the dashboard backend and wr-core
openssl rand -hex 32

# Signs the browser session cookie
openssl rand -hex 48

# Enables the keyed-Gumbel text watermark detector
openssl rand -hex 32
```

Open `.env` and:

```bash
nano .env
```

- Replace `WATERMARKS_SERVER_API_KEY=REPLACE_WITH_openssl_rand_hex_32` with
  the first hex string.
- Replace `SESSION_SECRET=REPLACE_WITH_openssl_rand_hex_48` with the second.
- Replace `WATERMARKS_GUMBEL_KEY=REPLACE_WITH_openssl_rand_hex_32` with
  the third.
- Confirm the other values (they are already filled in for you):

```dotenv
DASHBOARD_ORIGIN=https://aiagent.sciencedomain.info
WATERMARKS_SERVICE_URL=http://wr-core:8765
ADMIN_USERNAME=adminai
ADMIN_PASSWORD=Admin#Ai#2026*
COOKIE_SECURE=1
```

> **Note:** `ADMIN_PASSWORD` is only used the **first time** the backend
> boots. After that, credentials live (bcrypt-hashed) in the
> `dashboard-data` Docker volume and you rotate them from inside the
> dashboard (`Change password` in the top-right corner).

Lock the file down:

```bash
chmod 600 .env
```

---

## 5. Build & start the stack

```bash
cd /opt/watermarks-remover
docker compose up --build -d
```

This starts three containers:

| Service            | Purpose                                | Host binding        |
| ------------------ | -------------------------------------- | ------------------- |
| `wr-core`          | The watermarks-remover HTTP API        | `127.0.0.1:8765`    |
| `wr-dashboard-api` | FastAPI proxy (auth + hides API key)   | internal only       |
| `wr-dashboard-ui`  | React UI served by Nginx (in-container)| `127.0.0.1:8080`    |

All three are bound to **loopback only** — public access is provided
exclusively by the host Nginx you'll configure in step 7.

Verify:

```bash
docker compose ps
curl -sf http://127.0.0.1:8080 | head -1   # should return an <!doctype html>
curl -sf http://127.0.0.1:8765/health      # should return {"ok":true,...}
```

---

## 6. Install Nginx + Certbot

```bash
sudo apt -y install nginx certbot python3-certbot-nginx
sudo systemctl enable --now nginx
```

---

## 7. Set up the vhost

The repo already contains a ready-to-use vhost file. Install it:

```bash
sudo cp /opt/watermarks-remover/deploy/nginx/aiagent.sciencedomain.info.conf \
        /etc/nginx/sites-available/aiagent.sciencedomain.info

sudo ln -s /etc/nginx/sites-available/aiagent.sciencedomain.info \
           /etc/nginx/sites-enabled/aiagent.sciencedomain.info

# Optional: drop the default Nginx welcome page
sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t && sudo systemctl reload nginx
```

At this point `http://aiagent.sciencedomain.info` should already be
proxying to the dashboard (still plain HTTP).

---

## 8. Issue the HTTPS certificate

```bash
sudo certbot --nginx \
  -d aiagent.sciencedomain.info \
  --agree-tos --redirect --no-eff-email \
  -m your-email@example.com
```

Certbot will:

- Prove ownership over HTTP-01,
- Fetch a Let's Encrypt certificate,
- Rewrite the vhost to serve HTTPS on 443 and redirect port 80 → 443.

Auto-renewal is already configured by the Certbot package
(`systemctl list-timers | grep certbot` to see it).

---

## 9. Verify end-to-end

Open **https://aiagent.sciencedomain.info** in your browser.

1. Sign in with **`adminai` / `Admin#Ai#2026*`**.
2. Drop a file into the drop-zone, pick an action (`Clean` / `Inspect` /
   `Detect`), and run it.
3. Click **`Change password`** in the top bar and rotate the password —
   the new one persists in `dashboard-data` and survives restarts.

**Detectors and scanners you get out of the box:**

- **`c2patool`** — bundled into the `wr-core` image, so the Inspect panel
  scans C2PA provenance manifests (no "Limited scan" heads-up).
- **`exiftool`** — bundled too, scans EXIF / XMP tags.
- **`Stylometry`** — always runs on text files of ≥ 30 words, flags likely
  AI-written content by writing style.
- **`Gumbel` (keyed-Gumbel EXP)** — enabled by the `WATERMARKS_GUMBEL_KEY`
  you generated in step 4. Only fires against text watermarked with the
  same key (self-hosted setups), so it will normally report "no watermark".
- **`MarkLLM`** — research harness, disabled by default. Enable only if you
  need it (see `.env.example`, `MARKLLM_DIR`).

If anything is off, jump to **Troubleshooting** at the bottom.

---

## 10. Day-2 operations

### Update to a newer release

```bash
cd /opt/watermarks-remover
git pull                             # or: git fetch --tags && git checkout vX.Y.Z
docker compose up --build -d
```

Only the containers that actually changed are rebuilt; the
`dashboard-data` volume (your rotated password) is preserved.

### Restart everything

```bash
docker compose restart
```

### Look at logs

```bash
docker compose logs -f wr-core
docker compose logs -f wr-dashboard-api
docker compose logs -f wr-dashboard-ui
```

### Reset the admin password to the one in `.env`

```bash
docker compose down
docker volume rm watermarks-remover_dashboard-data
docker compose up -d
```

### Full uninstall

```bash
cd /opt/watermarks-remover
docker compose down -v          # -v also removes named volumes
sudo rm /etc/nginx/sites-enabled/aiagent.sciencedomain.info
sudo rm /etc/nginx/sites-available/aiagent.sciencedomain.info
sudo systemctl reload nginx
```

---

## Troubleshooting

**`docker compose up` fails on `wr-core` build**
The core image builds heavy Python deps. On a 1 GB VPS you can hit an OOM.
Bump swap (`sudo fallocate -l 2G /swapfile && sudo mkswap /swapfile &&
sudo swapon /swapfile`) or use a 2 GB+ VPS.

**`502 Bad Gateway` in the browser**
Container isn't listening. Check `docker compose ps` and
`docker compose logs wr-dashboard-ui`. Make sure port `8080` is bound on
`127.0.0.1`.

**Login button spins forever / "Unable to reach the dashboard service"**
The browser can't reach `/api/*`. Confirm the host Nginx vhost includes
`proxy_pass http://127.0.0.1:8080;` (not `localhost` on IPv6-only stacks)
and that `sudo nginx -t` is clean.

**`Incorrect username or password` even with the right creds**
You already changed the password from inside the dashboard and forgot
the new one. Follow **"Reset the admin password"** above.

**Certbot fails with `DNS problem`**
Your A record is still propagating. Re-check
`dig +short aiagent.sciencedomain.info` from an external network,
wait 5–10 min, and retry.

**Cleaning a big file times out**
Increase `proxy_read_timeout` / `proxy_send_timeout` in the host Nginx
vhost. Defaults in the shipped conf are already 600 s.

---

## What lives where

```
/opt/watermarks-remover/
├── .env                         # your production secrets (chmod 600)
├── .env.production.example      # template you copied from
├── compose.yaml                 # 3-service Docker Compose stack
├── backend/                     # FastAPI proxy (Dockerfile + server.py)
├── frontend/                    # React UI (Dockerfile + built by Vite)
├── service/                     # original wr-core service (unchanged)
└── deploy/
    └── nginx/
        └── aiagent.sciencedomain.info.conf   # host vhost you installed
```

That's it — you now have a private, HTTPS-protected watermarks-remover
dashboard at **https://aiagent.sciencedomain.info**.
