# Using Zonebuddy

A five-minute walkthrough of everything the app does.

## Sign in

Open `/login`. The card prints the demo credential (`cenius@cenius.ai` / `cenius`) and a
**Fill demo credentials** button; the eye button toggles the password. A wrong password produces a
single non-committal message — the form never reveals whether the address exists.

`/signup` creates a real account (email, password ≥ 8 characters, confirmation). Field errors
appear under each input and are announced through an `aria-live` region.

## Dashboard (`/app`)

- Four summary tiles: number of teams, total members, the best shared window this week, and how
  many read-only links exist.
- A dense table of your teams: member count, a Mon–Sun sparkline of shared hours per day, share-link
  count, last update, and an **Open planner** link.
- The sticky bar above the table holds the **New team** form: type a name, press **Create team**,
  and you land directly in the new team's planner.

## Team planner (`/app/teams/:id`)

**Members panel** — each row shows the member's colour, home zone, working hours and their current
local time (refreshed each minute). **Edit** fills the form with that member; **Remove** asks for
confirmation inline.

The form below adds a member: name, home time zone (type to search 400+ IANA zones, or keep the
prefilled value), start and end of the working day, and a colour from the six-series palette.
Validation runs on submit and is mirrored by the server: a missing name, an unknown zone, or an
end time at/before the start time comes back as a field-level message and nothing is saved.

**Overlap grid** — 7 days × 24 hours in the reference zone chosen at the top of the page. Cells
shade with the number of members at work and carry a dot per working member; hover a cell for the
names. The legend shows each member's colour and hours. `‹`, `›` and **This week** move between
weeks; the header shows the shared hours for today and the Mon–Fri average.

**Meeting slots** — pick a date (defaults to today, or the next weekday on a weekend) and a length
of 30, 60 or 90 minutes, then **Find slots**. The server returns the times where every member is
inside working hours, ranked by how close each slot's local midpoint is to each member's working-day
midpoint. Every result lists all members' local start/end times. If nothing fits, the panel explains
the reason (a member outside hours all day, or a shared window shorter than the requested meeting)
and offers the next day that works.

**Share a plan** — **Create share link** mints a token URL. **Copy** puts it on the clipboard
(with a "select and Ctrl+C" fallback when the browser blocks clipboard access), **Open** navigates
to the read-only view, and **Revoke** asks for confirmation and deletes the token.

**Rename / delete** — the team name field in the header renames in place; **Delete team** confirms
inline and removes the team, its members and its share links in one atomic store write.

## Public plan (`/share/:token`)

Read-only for anyone, signed in or not: team name, member table with local times, the overlap grid
with week navigation and a reference-zone switcher, and the slot suggestions for a chosen date.
There are no edit controls, no member form and no share panel. A revoked token, or a token whose
team was deleted, shows the "This plan link is no longer available" page with a sign-in link.

## Keyboard and accessibility notes

- Every form is reachable by `Tab`, submits on `Enter`, states its rules before submit, focuses the
  first invalid field, and keeps the typed values when the server rejects a submission.
- Submit buttons disable and the handlers are re-entrancy guarded, so a double click never creates
  two records.
- Destructive actions (remove member, revoke link, delete team) confirm inline.
- Errors render in `role="alert"` / `aria-live="polite"` regions.
- Layout reflows to a single column below 1000px; tables become labelled cards, the grid scrolls
  horizontally inside its own container, and every control is at least 44px tall on touch screens.
