# DB Board Designer

A simple tool for drawing a single-phase DB (distribution) board.

- Choose the main switch, earth leakage and surge arrester
- Add circuits and pick their breaker sizes
- The drawing shows the live, neutral and earth wiring, the neutral and earth bars, and a circuit list
- Add an inverter with a battery, solar panels, DC isolator, DC breaker or fuse and DC surge arrester
- Put the whole board on backup, or split it into grid-only and backup sections
- Add a bypass (changeover) switch so the backup circuits can run straight from the grid
- Show the neutral-earth bond for backup: a bond contactor in the DB, or built into the inverter
- Breaker ratings: trip curve, breaking capacity (kA), earth leakage type, surge arrester and DC voltage ratings
- Cable sizes for each circuit, based on the SANS 10142-1 current ratings (to be confirmed by a registered electrician)
- Share a board as a code, or load a board from a code
- Single-phase and three-phase boards, and circuits that are not on the earth leakage
- Report mode: an automatic "Problems found" list, a "Make corrected version" button, and a two-page PDF (as found + corrected)
- Save the drawing as a picture or as an A4 or A3 PDF

Open `index.html` in any web browser to use it. Your board is remembered in that browser.
