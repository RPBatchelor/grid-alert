# Pilot deployment on a Raspberry Pi 5 — grid-alert.com

This runs Grid Alert Victoria 24/7 on a Raspberry Pi 5 at home or in the office.
Pilot users reach it from anywhere (office, home, phone) at **https://grid-alert.com** and
sign in with a one-time email code. No router ports are opened.

```
Pilot users (browser/phone)
        │  HTTPS + sign-in (Cloudflare Access)
        ▼
Cloudflare edge ◄──── outbound-only tunnel ──── Raspberry Pi 5
                                                 ├─ grid-alert-tunnel  (cloudflared)
                                                 └─ grid-alert-app     (Node server + historian)
                                                      └─ ./data/history.sqlite (+ daily backups)
```

**Costs:**

- Hardware: about A$200–250 one-off (if you don't already have it).
- Domain: about A$15–20 a year.
- Cloudflare Tunnel and Access: free for up to 50 users.
- Power: about A$15 a year.

**Time:** about 1–1.5 hours end to end, most of it waiting for installs and the first build.

---

## 0. Before you start (on your PC)

1. **Commit and push** the deployment files to GitHub, so the Pi can download them:
   - `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example`
   - `DEPLOY.md`, `scripts/pi-update.sh`
   - the `server/` changes
2. **Check the repository's visibility.**
   - If it is **private**, create a GitHub fine-grained personal access token with *read-only Contents* access to this repository. You will paste it as the password when the Pi clones the repo.
   - A public repo needs nothing.
3. **Have these ready:**
   - **The domain `grid-alert.com`** (registered). Step 6a puts it on Cloudflare if it isn't already.
   - **A Cloudflare account** (free).
   - **The email addresses of your pilot users.**

## 1. Hardware

| Item | Notes |
|---|---|
| Raspberry Pi 5, 4 GB or 8 GB | 4 GB is plenty |
| Official 27 W USB-C power supply | Under-powered supplies cause random restarts |
| Active Cooler (or a case with a fan) | Keeps it cool when running 24/7 |
| NVMe SSD + M.2 HAT+ (or a USB 3 SSD) | **Use an SSD, not only a microSD card.** Cards wear out under constant database writes. |
| Ethernet cable | Steadier than Wi-Fi for an always-on server |
| Optional: small UPS or UPS HAT | Avoids gaps in history during short power cuts |

## 2. Check the Pi is ready

Your Pi is already set up: hostname **`helly`**, user **`ryan`**, with SSH working. From your PC
(PowerShell or a terminal):

```sh
ssh ryan@helly
```

If `helly` isn't found, try `ssh ryan@helly.local`, or use the Pi's IP address from your
router's device list (e.g. `ssh ryan@192.168.1.50`). The same applies to every `helly` below.

Then run these checks on helly:

```sh
uname -m                                  # aarch64 → 64-bit OS (required)
findmnt -no SOURCE /                      # /dev/nvme0n1p2 or /dev/sda2 → running from an SSD
                                          # /dev/mmcblk0p2 → running from the microSD card
free -h                                   # 4 GB or more is comfortable
timedatectl | grep "Time zone"            # should show Australia/Melbourne
```

- **`uname -m` shows `armv7l`:** the OS is 32-bit. Reinstall Raspberry Pi OS Lite **(64-bit)** with Raspberry Pi Imager, keeping hostname `helly` and user `ryan`.
- **Running from the microSD card:** this works for a trial, but the card will wear out under constant database writes. Move to an SSD before the pilot: copy the system across with Raspberry Pi Imager or `rpi-clone`, then set *Advanced Options → Boot Order* in `sudo raspi-config`.
- **Wrong time zone:** run `sudo timedatectl set-timezone Australia/Melbourne`.

## 3. Prepare helly

On helly (signed in as `ryan`):

```sh
# Update everything
sudo apt update && sudo apt full-upgrade -y

# Install git, Docker and automatic security updates
sudo apt install -y git unattended-upgrades
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER

# Log out and back in so the docker group applies
exit
```

```sh
ssh ryan@helly
docker run --rm hello-world     # should print "Hello from Docker!"
```

## 4. Download the app and start it (local only)

```sh
cd ~
git clone https://github.com/RPBatchelor/grid-alert.git
cd grid-alert

mkdir -p data           # create the history folder as your user (the app runs as UID 1000)
cp .env.example .env    # settings; the tunnel token goes in here later

export GIT_COMMIT=$(git rev-parse --short HEAD)
docker compose up -d --build app    # first build takes ~5–10 minutes on a Pi 5
```

Check it:

```sh
curl http://localhost:8080/api/health
# {"ok":true,"uptimeSeconds":…,"lastSnapshot":"…",…}
docker compose ps        # grid-alert-app should show "healthy" after ~2 minutes
```

From a PC on the same network, open **http://helly:8080** (or `http://helly.local:8080`). You should see the live map.

## 5. Bring across the history you already have (optional)

The history recorded on your PC since 25 October can continue on the Pi.

1. **On your PC**, in the project folder, make a clean single-file copy. It folds in any pending writes, so it is safe to run even if the dev server is still running:

   ```powershell
   node -e "new (require('node:sqlite').DatabaseSync)('data/history.sqlite').exec(\"VACUUM INTO 'data/history-export.sqlite'\")"
   ```

2. **On helly**, stop the app:

   ```sh
   cd ~/grid-alert && docker compose stop app
   ```

3. **On your PC**, copy the file over:

   ```powershell
   scp data/history-export.sqlite ryan@helly:~/grid-alert/data/history.sqlite
   ```

4. **On helly**, remove the new database's leftover files and start again:

   ```sh
   rm -f data/history.sqlite-wal data/history.sqlite-shm
   docker compose start app
   ```

Your existing events and Trends history now show on the Pi.

## 6. Secure public access with Cloudflare

Do these in order. The sign-in is created **before** the address goes live, so the app is
never exposed without it.

### 6a. Put your domain on Cloudflare

- Bought through Cloudflare: nothing to do.
- Bought elsewhere: in Cloudflare, add the site (Free plan), then change your registrar's nameservers to the two Cloudflare gives you. This can take up to a few hours.

### 6b. Set up Zero Trust (one-off)

1. Open **one.dash.cloudflare.com**.
2. Choose a team name and the **Free** plan. It may ask for a payment card even on the free plan.

### 6c. Create the sign-in (Access application)

1. Go to **Access → Applications → Add an application → Self-hosted**.
2. Application name: `Grid Alert Victoria`.
3. Public hostname: leave **subdomain blank**, domain `grid-alert.com`. (Optionally add a second hostname `www` · `grid-alert.com` so both addresses are protected.)
4. Session duration: `24 hours`. Choose a shorter one if you prefer.
5. Add a policy:
   - Name: `Pilot users`
   - Action: **Allow**
   - Include → **Emails** → add each pilot user's email address
6. Login methods: **One-time PIN**, which is on by default. Users get a code by email. You can add Google or Microsoft sign-in later.
7. Save.

### 6d. Create the tunnel

1. Go to **Networks → Tunnels → Create a tunnel**.
2. Choose **Cloudflared**, name it `helly`, and save.
3. On the install screen choose **Docker**. Copy **only the long token** after `--token` in the command shown. Don't run that command.
4. On helly:

   ```sh
   nano .env        # paste after TUNNEL_TOKEN=   then Ctrl+O, Enter, Ctrl+X
   ```

5. Back in Cloudflare, on the tunnel's **Public hostnames** tab, add:
   - Subdomain **blank**, domain `grid-alert.com`
   - If Cloudflare says a DNS record already exists for `grid-alert.com` (e.g. the registrar's parking page), delete that record under the domain's **DNS → Records**, then add the hostname again.
   - Service type **HTTP**, URL **`app:8080`**. `app` is the container's name inside Docker, not `localhost`.
6. Save.

### 6e. Start the tunnel

```sh
docker compose up -d
docker compose logs tunnel | tail -5     # look for "Registered tunnel connection"
```

The tunnel's status in the Cloudflare dashboard should show **Healthy**.

## 7. Test it like a user

1. On your phone, **turn off Wi-Fi** and open `https://grid-alert.com`.
2. Expect Cloudflare's sign-in page. Enter a pilot email, then type the code that arrives by email. The map loads.
3. Try an email that is **not** on the list. It should be refused.
4. Start and stop a test event, then check the Pi records who did it:

   ```sh
   docker compose logs app | grep AUDIT
   ```

5. Reboot the Pi (`sudo reboot`). After about 2 minutes the site comes back by itself.

Once this works you can close the local-network shortcut. Delete the two `ports:` lines in
`docker-compose.yml`, then run `docker compose up -d`. Afterwards everyone, you included, goes
through the sign-in.

## 8. Optional: get an alert if it stops recording

Use a free uptime monitor (e.g. UptimeRobot) on the health check. It must be reachable
without signing in:

1. In Cloudflare **Access → Applications**, add another **Self-hosted** app for `grid-alert.com` with **path** `api/health`. Give it a policy with Action **Bypass** and Include **Everyone**. The health check shows only uptime and the last snapshot time.
2. In UptimeRobot, add a **Keyword** monitor for `https://grid-alert.com/api/health` with keyword `"ok":true`, checked every 5 minutes, alerting your email.

`"ok"` turns false if no snapshot has been recorded for 15 minutes, which catches a stuck
collector as well as a dead Pi.

## Day-to-day

| Task | Command (on helly as `ryan`, in `~/grid-alert`) |
|---|---|
| Is it healthy? | `docker compose ps` and `curl localhost:8080/api/health` |
| Live logs | `docker compose logs -f app` |
| Who changed events | `docker compose logs app \| grep AUDIT` |
| Update to the latest code | `sh scripts/pi-update.sh` |
| Restart | `docker compose restart` |
| Add or remove pilot users | Cloudflare → Access → Applications → the app → Policies |

**Backups:**

- **On helly:** a copy of the history is written to `data/backups/` every day, and the last 14 are kept.
- **Off the Pi:** these copies sit on the same disk, so copy one off regularly, e.g. weekly from your PC:

  ```powershell
  scp ryan@helly:~/grid-alert/data/backups/* D:\backups\grid-alert\
  ```

- **To restore:**
  - `docker compose stop app`
  - copy the backup over `data/history.sqlite` and delete the `-wal` and `-shm` files
  - `docker compose start app`

**Windy:** if you buy a Windy Map Forecast API key, add `grid-alert.com` to the key's
allowed domains at api.windy.com, then enter the key in Settings → Integrations.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `permission denied` on `/data` in `docker compose logs app` | The `data` folder was created by Docker as root. Run `sudo chown -R 1000:1000 data`, then `docker compose restart app`. |
| Build fails or is killed | Out of memory on a 2 GB Pi. Close other apps or add swap: `sudo dphys-swapfile swapoff; sudo sed -i 's/CONF_SWAPSIZE=.*/CONF_SWAPSIZE=2048/' /etc/dphys-swapfile; sudo dphys-swapfile setup; sudo dphys-swapfile swapon`. |
| `grid-alert-app` shows **unhealthy** | Snapshots have stopped. Check `docker compose logs app` for "Collector fetch failed", and check the Pi's internet. |
| Tunnel shows **Down** in Cloudflare | Check `docker compose logs tunnel`. Usually a wrong or empty `TUNNEL_TOKEN` in `.env`. Fix it, then `docker compose up -d`. |
| Cloudflare error 502 or 1033 | The public hostname's service must be `http://app:8080`, not `localhost`. |
| Sign-in code never arrives | Check spam. The email must be listed in the Access policy exactly. |
| Times look wrong | Run `timedatectl` on the Pi and set `Australia/Melbourne` with `sudo timedatectl set-timezone Australia/Melbourne`. |
| Gaps in Trends | The Pi or the internet was down. Gaps are expected and shown honestly. A UPS reduces them. |

## Limits of this setup (pilot only)

- **Single point of failure.** It depends on one Pi, home or office power, and an internet connection.
- **Your equipment and accounts.** It runs on hardware and accounts you own, not AusNet IT. Agree this with your manager and Technology before sharing it beyond a small pilot group.
- **Access is by email list, not AusNet sign-in.** Remove people from the policy when they leave the pilot.
- **Moving to company hosting later is easy.** The same container runs unchanged on AWS or other company hosting.
