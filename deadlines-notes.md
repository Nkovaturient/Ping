# deadlines.json research notes (verified 2026-07-07)

Every entry in `deadlines.json` was checked against a live, currently-open
application window with a citable source — no guessed or placeholder dates.
The two entries that used to be here (`ssc`, `upsc`) were **removed**: their
real deadlines (SSC CGL 2026 closed 25 June 2026; UPSC CSE 2026 closed
27 February 2026) had already passed and no longer matched the placeholder
dates that were previously in this file.

## Portals with no active application window as of 2026-07-07

These were researched and confirmed closed, with no new cycle open yet.
Re-check periodically and add a `deadlines.json` entry once a new notification
drops — do not backfill guessed dates in the meantime.

| Portal | Last known status |
| --- | --- |
| `upsc` | UPSC CSE/IFS 2026 closed 27 Feb 2026. No new cycle announced. |
| `ssc` | SSC CGL 2026 closed 25 Jun 2026 (reopened window). SSC CHSL 2026 closed 31 May 2026. |
| `nta` | NEET UG 2026 closed 11 Mar 2026 (re-exam 21 Jun 2026, no new registration needed). CUET UG 2026 closed 26 Feb 2026. JEE Main 2027 not yet notified (expected Oct/Nov 2026). |
| `rrb` / `rrb_apply` | RRB NTPC 2025-26 cycle closed Nov/Dec 2025. RRB Group D (CEN 09/2025) closed 9 Mar 2026. No new CEN notification yet. |
| `indiapost_gds` | GDS Online Engagement Schedule-I (Jan 2026) closed 16 Feb 2026; currently in merit-list/DV phase. No new schedule open. |
| `rbi` | RBI Grade B 2026 closed 20 May 2026. RBI Assistant 2026 closed 8 Mar 2026. |
| `bpsc` | BPSC 72nd CCE 2026 closed 31 May 2026 (prelims scheduled 26 Jul 2026). |
| `rpsc` | RPSC RAS 2026 closed 3 Jul 2026. |
| `wbpsc` | WBPSC Principal Recruitment 2026 closed (extended) 3 Jul 2026. |

## Portals with multiple active windows (only one entry kept per portal)

- **UPSSSC**: also has Auditor/Assistant Accountant (14 Jul – 3 Aug 2026) and
  Forest Guard (30 Jun – 20 Jul 2026) windows open alongside Cane Supervisor.
  Add more `deadlines.json` entries for these if you want alerts for all of
  them — the schema supports multiple entries per `portal` id.
- **MPPSC**: also has Assistant Town Planner (1–31 Jul 2026) and
  Assistant Director Fisheries/Higher Education (17 Jul – 16 Aug 2026) open
  alongside the SSE Mains window kept here.

Re-verify all of the above against the official portals before relying on
them for anything beyond this pilot — recruitment bodies frequently extend
or reopen windows (as happened with SSC CGL, WBPSC Principal, and RBI Grade B
in this same cycle).
