# GPS Accuracy & How It Gates ON/OFF Toggles

This document describes exactly how the Asset Control app (`index.html`) uses GPS
to decide whether an operator is allowed to toggle an asset ON or OFF. It reflects
the behaviour actually implemented in the code, including the specific thresholds
and the order in which checks run.

---

## The two numbers that matter

Every toggle decision is built from two measurements:

- **distance** — how far the operator is from the asset, in metres. Computed with
  the haversine formula between the operator's current GPS position and the
  asset's stored `lat`/`lng`.
- **accuracy (`acc`)** — the radius of uncertainty around the operator's GPS fix,
  in metres, as reported by the device (`pos.coords.accuracy`, rounded). A reading
  of `±20m` means the true position is somewhere within 20 m of the reported point.

A third value sets the bar:

- **tolerance (`tol`)** — the per-asset allowed radius. Taken from the operator's
  asset assignment (`tolerance`), defaulting to **50 m** when not specified.

---

## How the position itself is chosen (best-fix buffer)

The app does not blindly trust the latest GPS reading. It keeps a rolling buffer
of the **last 5 fixes** (`GPS_FIX_BUF = 5`) and always promotes the one with the
**lowest accuracy value** (i.e. the tightest, most precise fix) as the current
position:

```
currentPos = the fix in the last 5 with the smallest acc
```

This prevents a single bad reading — for example a momentary cell-tower fallback
with `±300m` — from overriding a good recent satellite fix of `±8m`. Location is
acquired with `enableHighAccuracy: true`, `maximumAge: 0` (no cached positions),
and a 20-second timeout.

---

## The core rule: best-case distance

The gate is **not** a simple "distance ≤ tolerance". The app gives the operator
the benefit of the GPS uncertainty by using the **best-case distance**:

```
bestCase = max(0, distance − accuracy)
near     = bestCase ≤ tolerance
```

In plain terms: the app subtracts the accuracy radius from the measured distance,
asking *"could the operator plausibly be within tolerance, given how fuzzy this
fix is?"* If yes, the toggle is allowed.

### Worked examples (tolerance = 50 m)

| Measured distance | Accuracy | best-case = dist − acc | Within 50 m tolerance? | Toggle button |
|------------------:|---------:|-----------------------:|:----------------------:|:-------------:|
| 30 m              | ±10 m    | 20 m                   | Yes                    | Enabled       |
| 60 m              | ±20 m    | 40 m                   | Yes (benefit of doubt) | Enabled       |
| 60 m              | ±5 m     | 55 m                   | No                     | Disabled      |
| 200 m             | ±190 m   | 10 m                   | Yes (very fuzzy fix)   | Enabled\*     |
| 120 m             | ±15 m    | 105 m                  | No                     | Disabled      |

\* The 200 m / ±190 m case passes the distance gate because the operator *could*
be standing on the asset given the huge uncertainty — but it then triggers the
**low-accuracy confirmation** described below, because the accuracy is poor.

---

## The accuracy threshold and the confirmation step

A separate, independent check governs **accuracy quality**:

```
ACC_POOR_THRESH = 50   (metres)
```

When a toggle is attempted and the accuracy is **worse than 50 m** (`acc > 50`),
the app does **not** silently toggle. It first shows a **Low GPS Accuracy
confirmation modal** stating the measured accuracy, the measured distance, and the
tolerance, and asks the operator to confirm they are *physically standing at the
asset*. The toggle only proceeds if the operator explicitly confirms.

If accuracy is **50 m or better** (`acc ≤ 50`), no confirmation is needed and the
toggle proceeds directly (assuming the distance gate and cooldown pass).

This means accuracy affects the toggle in **two distinct ways**:

1. **Distance gate (always):** accuracy widens the benefit of the doubt via
   `bestCase = distance − accuracy`. Worse accuracy makes it *easier* to pass the
   distance check, because the operator could plausibly be closer than measured.
2. **Confirmation gate (only when `acc > 50 m`):** worse accuracy forces a manual
   "I am physically here" confirmation before the toggle fires.

The two pull in opposite directions on purpose: a fuzzy fix won't *block* a
genuinely-present operator at the distance step, but it *does* force them to take
explicit responsibility for being on-site before the state changes.

---

## The full order of checks in a toggle

When an operator taps the ON/OFF button, the toggle runs through these gates in
order. Failing any one stops the toggle:

1. **Person, asset, and position must exist.** If no GPS fix yet → *"Location not
   available yet"* and stop.
2. **Distance gate.** If the asset has coordinates and `bestCase > tolerance` →
   *"Too far away (Xm ±Ym). Must be within Zm"* and stop. (Assets with no stored
   coordinates skip this gate.)
3. **Accuracy confirmation.** If `acc > 50 m` and not yet confirmed → show the Low
   GPS Accuracy modal and stop until the operator confirms.
4. **Cooldown.** Each operator+asset pair has a **5-minute cooldown**
   (`COOLDOWN_MS = 5 min`) after a successful toggle. A second toggle inside that
   window → *"Wait Xm Ys before toggling again"* and stop.
5. **In-flight guard.** If a toggle for this asset is already saving →
   *"Still saving the previous change…"* and stop. (Prevents double-taps from
   issuing two concurrent writes.)
6. **Write, then commit.** The record is written to the database first; only after
   that succeeds is the asset's ON/OFF state updated in memory and on the card. If
   the write fails, the state is left unchanged and an error is shown — the asset
   does not flip to a state that was never saved.

---

## What the operator sees on each asset card

Two badges communicate the GPS situation at a glance:

**Distance badge**
- ✅ green `Xm / Ym` — within tolerance (best-case), toggle enabled
- 📵 red `Xm / Ym` — too far (best-case), toggle disabled
- 📍 `Unknown` — asset has no stored coordinates; distance can't be checked

**Accuracy badge** (shown whenever there is a position fix)
- `±Xm` green — accuracy is 50 m or better (good)
- `⚠ ±Xm` amber — accuracy between 51 m and 150 m (poor; will trigger confirmation)
- `⚠ ±Xm` red — accuracy worse than 150 m (bad; will trigger confirmation)

The toggle button is **disabled** whenever the operator is out of best-case range
or a cooldown is active. It becomes enabled the moment a better fix brings the
best-case distance within tolerance.

---

## Reference: constants

| Constant | Value | Meaning |
|---|---|---|
| `GPS_FIX_BUF` | `5` | Number of recent fixes kept; tightest one wins |
| `ACC_POOR_THRESH` | `50` m | Above this accuracy → confirmation modal required |
| default `tolerance` | `50` m | Allowed radius when an asset assignment omits one |
| `COOLDOWN_MS` | `5 min` | Per-operator, per-asset wait between toggles |
| accuracy badge: good / poor / bad | `≤50` / `≤150` / `>150` m | Card badge colour thresholds |

---

## Practical guidance for operators

- **Hold still for a few seconds** after opening the app. The best-fix buffer needs
  a couple of readings to settle on a tight fix, and standing still lets the device
  converge on a satellite-based position rather than a coarse network estimate.
- **A `±` value over 50 m means you'll be asked to confirm.** That's expected near
  buildings, under tree cover, or indoors. Only confirm if you are truly at the
  asset.
- **If the button is greyed out, you're (best-case) outside the tolerance radius.**
  Move closer to the asset, or wait for a tighter fix to come in.
- **After toggling, there's a 5-minute cooldown** on that specific asset for you.
  This is normal and prevents accidental rapid re-toggling.
