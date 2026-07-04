# Portal Pulse — India Govt Exam Portal Uptime Monitor

A free, public-good uptime & latency tracker for the ~15-20 portals Indian students hit
hardest during exam form-filling season (UPSC, SSC, NTA, IBPS, RRB, and major state PSCs).

**How it works:** a GitHub Actions job pings each portal's homepage every ~15 minutes,
records status + latency to a CSV, and a static dashboard (`index.html`, served via
GitHub Pages) reads that data straight out of the repo. No server, no database, no cost
beyond GitHub's free tier for public repos.

## Setup (5 minutes)

1. **Copy these files into your repo**, keeping the folder structure exactly as-is —
   `.github/workflows/uptime-check.yml` must stay under `.github/workflows/`.

2. **Give the workflow write access.**
   Repo → Settings → Actions → General → scroll to "Workflow permissions" →
   select **Read and write permissions** → Save.
   (Without this, the job can check the portals but can't commit the results.)

3. **Enable GitHub Pages.**
   Repo → Settings → Pages → Source: **Deploy from a branch** → Branch: `main`, folder `/ (root)` → Save.
   Your dashboard will be live at `https://<your-username>.github.io/<repo-name>/`.

4. **Trigger the first run manually** so the dashboard isn't empty while you wait for the schedule:
   Repo → Actions tab → "Portal Uptime Check" → **Run workflow**.

5. Data accumulates every 15 minutes from there. The live status grid is useful
   immediately; the peak-hour heatmap becomes meaningful after a few days of data.

## Customizing

- **Add/remove a portal:** edit `config/portals.json`. No code changes needed.
- **Change check frequency:** edit the cron line in `.github/workflows/uptime-check.yml`.
  15 minutes is a reasonable default — frequent enough to catch outage windows,
  light enough to be a good citizen toward government servers.
- **Data format:** each month gets its own file, `data/uptime-YYYY-MM.csv`, with columns
  `timestamp_utc, portal_id, status_code, latency_ms, up`. Plain CSV, easy to analyze
  separately (pandas, Excel, whatever) if you want to go further than the built-in heatmap.

## Things worth knowing

- **GitHub Actions schedules can run a few minutes late**, especially at busy times —
  this is normal and not a bug in the workflow.
- **Scheduled workflows get disabled after 60 days of zero repository activity.**
  Since every run commits data, this shouldn't happen on its own — but if you fork this
  and let it sit unused, check the Actions tab occasionally.
- **This only checks public homepages**, never login pages or form-submission endpoints —
  by design, both to stay unambiguously legal/polite and because that's all that's needed
  to detect "the whole site is down or crawling."
- **Free tier is enough.** Public repos get unlimited Actions minutes; this job takes well
  under a minute to run every 15 minutes.

## Not covered yet (ideas for later)

- A notification layer (Telegram/WhatsApp bot) that reads this same data and pushes
  "SSC is down right now" or "last-3-days spike incoming" alerts.
- Scraping official notification pages to auto-populate a deadline calendar alongside
  the uptime data, so the two can be shown together.
