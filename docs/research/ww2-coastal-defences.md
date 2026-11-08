# WW2 coastal defences: the reference for static gun emplacements

R&D companion to `ww2-surface-combatants.md`, for the coastal-defences work (branch `coastal-defences`). It records what real WW2 coastal and siege guns measured, how they compare with the same calibres afloat, and which ratios the game copies into static emplacements. Figures are from secondary sources (NavWeaps, Wikipedia, D-Day Overlord, battlefieldsww2.com), listed at the end. Where sources disagree, the commonly cited value is used and the range noted. Where a figure could not be confirmed online it is marked **(unconfirmed)**.

## The emplacements

| Emplacement | Gun | Mount | Barrels | Shell | Max range | Rate of fire | Arc |
|---|---|---|---|---|---|---|---|
| Batterie Hamburg, Fermanville (Cherbourg) | 24 cm SK L/40 (1890s Austro-Hungarian/German cruiser gun) | Concrete SK casemate, one gun each | 4 × 1 | 140–151 kg | 26.6 km at +46° (about 25 km quoted for the battery) | 3 rpm | Coast mount ±150°; casemate restricted it (one NE shield cut away to widen the arc). Casemate arc ~120° **(unconfirmed)** |
| Austrått Fort (Ørland, Trondheim) | 28 cm SK C/34, turret "Caesar" from *Gneisenau* | Armoured triple turret (Drh LC/34) on land | 1 × 3 | 315–330 kg | 40.9 km at +40° (38 km quoted for the fort) | 3.5 rpm | Ship turret ±150°, train 7.2°/s. On land nothing blocks it; full land arc **(unconfirmed)** |
| Battery Davis (Fort Funston) / Battery Townsley (Fort Cronkhite), San Francisco | 16"/50 M1919 (US Army) | Barbette carriage; Davis built open, both casemated by 1943 | 2 × 1 per battery | 950–1,060 kg AP | 44.9 km at up to +65° (Townsley "25 miles") | about 1 rpm (NavWeaps note for coast-defence 16") | Open barbette 360°; casemated 145° |
| Kurosaki (Iki) / Tsushima / Pusan (IJA, optional) | 41 cm/45 3rd Year Type, turrets from cancelled *Tosa* / *Akagi* | Twin battleship turret on land | 3 × 2 | ~1,000 kg | 37.9–38.7 km | ~1.5–2 rpm (naval) | Turret (land arc not found) |
| Batterie Lindemann, Sangatte (Pas-de-Calais) | 40.6 cm SK C/34 ("Adolf" guns, meant for H-class battleships) | Single gun in a turret-like shield (Schiessgerüst C/39) inside a casemate; concrete up to 4 m | 3 × 1 | 1,030 kg normal; 600 kg "Adolf" light coast HE | 43 km (1,030 kg at +52°); 56 km (600 kg at 1,050 m/s, new barrel), 43.5 km (worn barrel) | about 2 rpm | Mount ±145° listed; casemate field ~120° **(unconfirmed)** |
| Schwerer Gustav (railway siege gun) | 80 cm Kanone (E) | Railway carriage on twin tracks; no traverse, aimed by a curved track | 1 | 4,800 kg HE (700 kg filling); 7,100 kg concrete-piercing (250 kg filling) | 47 km HE, 38 km AP | 1 round per 30–45 min (about 14 a day) | None (track-laid); elevation up to +48° |

Notes:
- **Batterie Hamburg** fought USS *Texas* and USS *Arkansas* on 25 June 1944. *Texas* knocked out one gun at 13:35, and the remaining three kept firing until the ships withdrew behind smoke. It is the classic case of a casemated battery duelling capital ships, and the battery won on points.
- **Lindemann** fired over 2,200 rounds at England in two years. Barrel life was about 180–300 rounds (sources vary), so the light "Adolf" shell traded weight for range and barrel wear.
- **Gustav** took about 250 men three days to assemble, plus thousands to lay track. One shell left a crater about 12 m wide and 12 m deep.

### Light coastal and anti-boat guns (brief)

| Gun | Shell | Range | Rate of fire | Traverse | Role |
|---|---|---|---|---|---|
| 5"/38 Mark 38 twin DP (ship) | 25 kg | 16.6 km surface; 11.3 km ceiling | 15–22 rpm per gun | 360°, train 25°/s, elevation 15°/s | The S-mount reference (`naval_s`) |
| Bofors 40 mm quad Mark 2 | 0.9 kg | ~10 km max; effective AA ~3–4.75 km | 160 rpm cyclic per barrel, 80–120 practical | 360° (train rate not confirmed online) | Point AA |
| 8.8 cm Flak 36 | 9.2 kg | 14.9 km ground; 8 km effective ceiling | 15–20 rpm | 360°, emplaced in 2.5 min | AA, used as anti-tank and anti-boat |
| US 90 mm M1/M2 (AMTB batteries) | 10.6 kg (M71 HE) | 19 km; 13.3 km ceiling | 20–24 rpm | 360° | AMTB batteries: 4 × 90 mm (2 on fixed T3/M3 mounts, 2 towed) + 2 × 37/40 mm, against motor torpedo boats |

## Were land guns bigger than ship guns?

Partly, and they always shot further for the same calibre.

- **Same gun, longer reach on land.** A ship turret's elevation is limited by the turret's size and the ship's stability, so most battleship mounts stop at 30–45°. On land, nothing heels, and the mount can sit in a pit. The 40.6 cm SK C/34 reached 36.8 km at the naval turret's 33° and 43 km at 52° on land. The 16"/50 reached 38.7 km on an Iowa at 45° and 44.9 km on the Army's M1919 barbette at 65°. The 24 cm went from 16.9 km (+30°) to 26.6 km (+46°).
- **Lighter shells for range.** Land batteries had no armoured ship to pierce at close range, so they could fire light, fast shells (Lindemann's 600 kg "Adolf" shell went 56 km against 43 km for the 1,030 kg shell).
- **Most coastal guns were ship guns.** Hamburg's 24 cm guns came from old cruisers, Austrått's turret from *Gneisenau*, the Japanese 41 cm turrets from cancelled battleships, and Lindemann's 40.6 cm guns from cancelled H-class battleships. The biggest coastal guns matched the biggest battleship guns. They did not exceed them (Yamato's 46 cm was the largest gun afloat or ashore in a fixed mount).
- **The truly biggest guns were railway siege guns.** Gustav and Dora (80 cm, 4.8–7.1 t shells) dwarfed any ship gun. Weight was no constraint on a railway, but the price was mobility and rate of fire: one shot every half hour, a crew in the thousands.

## The ratios that matter (5"/38 = 1)

The game copies the same three rules as the ship doc.

- **Reach:** in-game reach = `speed × maxTicks / 60`. The real range ratio to the 5"/38 (16.6 km) sets it.
- **Damage:** damage grows with shell weight. The ship doc describes this as √(shell weight), but the shipped catalogue is steeper: 60 / 350 / 800 / 1400 for 25 / 152 / 517 / 1,225 kg fits `damage ≈ 60 × (w / 25 kg)^0.81` (8" sits a little high, 12" a little low). New weapons below use that fitted curve so they line up with what already shipped; the √ version is shown for comparison.
- **Reload:** reload grows with the inverse of rate of fire. The ship doc says rate of fire to the 0.75 power, but the shipped endpoints (15 rpm → 240 ticks, 2 rpm → 1800 ticks) are linear. A gun firing at 16"-battleship speed therefore gets naval_xl's 1800 ticks.
- **Dodgeability:** shells reach full range in about 2 s (`naval_s` 1.0 s, `naval_m` 1.4 s, `naval_l` 1.7 s, `naval_xl` 1.8 s), so a fighter can dodge. The new long-range weapons stretch this to 2.3–2.7 s, because a heavier, longer-ranged, slower-firing gun should be the easiest one to dodge at the edge of its reach.

| Gun | Shell | Max range | Range ratio | Game reach (1800 × ratio) | Existing weapon reach | Fit |
|---|---|---|---|---|---|---|
| 5"/38 | 25 kg | 16.6 km | 1 | 1800 | `naval_s` 1800 | anchor |
| 8"/55 (ship) | 152 kg | 27 km | 1.63 | 2930 | `naval_m` 2767 | ship doc |
| 24 cm SK L/40 (Hamburg) | 151 kg | 26.6 km | 1.60 | 2880 | `naval_m` 2767 | same shell as US 8", within 4% |
| 28 cm SK C/34 (Austrått) | 330 kg | 40.9 km | 2.46 | 4430 | `naval_l` 3813 | lighter than the 12" shell, longer-ranged; `naval_l` is the closest |
| 16"/50 (Iowa) | 1,225 kg | 38.7 km | 2.33 | 4200 | `naval_xl` 4217 | ship doc |
| 16"/50 M1919 (Davis) | 1,060 kg | 44.9 km | 2.70 | 4870 | `naval_xl` 4217 | land elevation gives +15% |
| 40.6 cm SK C/34 normal (Lindemann) | 1,030 kg | 43 km | 2.59 | 4660 | — | |
| 40.6 cm "Adolf" light (Lindemann) | 600 kg | 56 km | 3.37 | 6070 | — | **1.44 × naval_xl** |
| 80 cm K (E) HE (Gustav) | 4,800 kg | 47 km | 2.83 | 5100 | — | |
| 80 cm K (E) AP (Gustav) | 7,100 kg | 38 km | 2.29 | 4120 | — | |

| Shell | Fitted damage `60 × (w/25)^0.81` | √ law anchored on naval_xl (`1400 × √(w/1225)`) |
|---|---|---|
| 600 kg (Adolf) | 787 | 980 |
| 1,030 kg (Lindemann normal) | 1,220 | 1,284 |
| 4,800 kg (Gustav HE) | 4,240 | 2,770 |
| 7,100 kg (Gustav AP) | 5,670 | 3,370 |

## Proposed game numbers

| Emplacement | Weapon | Barrels | Arc | Damage | Reload (ticks / s) | Speed | Life (ticks) | Reach | Flight | Radius | Splash |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `coastal_casemate_8in` (Batterie Hamburg) | `naval_m` as is | 1 | 120° casemate | 350 | 600 / 10 s | 2000 | 83 | 2767 | 1.4 s | 4 | — |
| `coastal_turret_11in` (Austrått) | `naval_l` as is | 3 | 360° | 800 | 1320 / 22 s | 2200 | 104 | 3813 | 1.7 s | 5 | — |
| `coastal_barbette_16in` (Battery Davis) | `naval_xl` as is | 2 | 360° | 1400 | 1800 / 30 s | 2300 | 110 | 4217 | 1.8 s | 6 | — |
| `coastal_xxl` (Lindemann 40.6 cm) | **new** | 1 | 120° casemate | **1200** | **1800 / 30 s** | **2600** | **140** | 6067 (1.44 × xl) | 2.3 s | **7** | — |
| `siege_xxxl` (Gustav 80 cm) | **new** | 1 | 30° (track, see below) | **4200** direct | **7200 / 120 s** (cap) | **1900** | **160** | 5067 | 2.7 s | **12** | **radius 160, falloffMin 30** |

How each was derived:

- **`coastal_casemate_8in`.** The 24 cm SK L/40 fires the same 151 kg shell as the US 8"/55 to the same range (ratio 1.60 against `naval_m`'s 1.54). Its 3 rpm is slower than the 8"'s 4 rpm, which would give about 800 ticks, but it's within the existing curve's scatter, so use `naval_m` unchanged. Arc: the coast mount itself trained ±150°, but casemates were built to cover a sea sector. 120° is the design value (the US 16" casemates reached 145°; the 145° figure could be used for a more generous emplacement).
- **`coastal_turret_11in`.** The 28 cm shell (330 kg) is lighter than the US 12" (517 kg), so `naval_l` damage slightly overstates it, while the land range (2.46) is longer than `naval_l`'s reach (2.12). The two errors roughly cancel, so use `naval_l` unchanged. Triple, as at Austrått. 360°: the ship's ±150° limit came from the superstructure, and a land turret has none. Traverse 7°/s (Gneisenau's 7.2°/s) if the game models turret slew.
- **`coastal_barbette_16in`.** The M1919 fires a shell close to the Iowa's (1,060 vs 1,225 kg). On land it reaches 15% further (2.70 vs 2.34). `naval_xl` fits. An optional land variant at `maxTicks` 127 (reach 4870) would reflect the higher elevation, but that would crowd `coastal_xxl`, so the proposal keeps `naval_xl` as is. Twin, 360° for an open barbette (145° if the game ever wants a casemated version like Townsley). Real US coast-defence 16" guns fired at about 1 rpm, half the ship rate. Keep 1800 for parity, or 2400 if emplacements feel too strong.
- **`coastal_xxl` (Lindemann).** Reach comes from the Adolf light shell (56 km, ratio 3.37 → 6070, 1.44 × `naval_xl`), the emplacement's reason to exist. Damage comes from the 1,030 kg normal shell on the fitted curve (1,220 → 1200), so it hits about as hard as a battleship gun but no harder. Mixing the two is a deliberate game simplification. Strictly, the long-range shell alone would be about 790 damage, and the heavy shell alone would reach about 4660. Rate of fire is 2 rpm, the same as the 16"/50, so reload is 1800. Speed 2600 and life 140 give 2.3 s of flight, a step above `naval_xl` (2300) in the same progression. Radius 7 follows the 3/4/5/6 sequence.
- **`siege_xxxl` (Gustav).** It uses the HE shell, which is both longer-ranged (47 km) and the area-effect round. Its reach (5067) sits between `naval_xl` and `coastal_xxl`: a siege gun is about mass, not range. Direct damage 4200 comes from the fitted curve (√ would give 2,770; the AP shell would give 5,670 at 38 km). The real rate (1 per 30–45 min) would give 40,000+ ticks on any rule, so reload is capped at the agreed 120 s (7200 ticks). That still makes its sustained DPS (35/s) lower than a single `naval_xl` barrel (47/s). Its value is the single, huge, area-denying hit. Speed 1900 and life 160 give the slowest shell in the set, at 2.7 s of flight, a visible, dodgeable lob. Radius 12.
  - **Splash.** The real crater was 12 m wide (about 26 u at the speedboat mapping B, 2.13 u/m). The blast and fragment zone of a 700 kg filling is far wider, roughly 50–100 m for serious damage. Under mapping B a destroyer is 244 u and a battleship 576 u (`capitalReference.ts`). Proposed `splashRadius` 160 (about a quarter to a third of a battleship, ~75 m real) and `splashFalloffMin` 30 (the crater). The existing missile splash shape fits (inverse-square falloff, `splashImpulse` scaled up, for example to 300). Splash scales with the ship-scale profile through `scaleWeaponDef`. Projectiles don't splash today, so this needs either projectile splash support or modelling the shell as a slow, non-homing missile-mode weapon.
  - **Arc.** The real gun had no traverse: it aimed by laying a curved track. 30° is a suggestion; use 0° with a re-aim "relay track" action if the game wants the full flavour.

Traverse rates, if the game models emplacement slew (real figures: 5"/38 Mk 38 25°/s, Gneisenau triple 7.2°/s; heavy coast mounts were slower still): casemate 120° 4°/s, triple turret 7°/s, barbette 5°/s, Lindemann 3°/s, Gustav 1°/s within its arc.

## What the game takes from this

1. **Emplacements reuse the naval weapons.** Hamburg's 24 cm is an 8", Austrått's 28 cm is a 12", and the 16" M1919 is a 16". Coastal batteries were mostly ship guns, so the `naval_*` weapons carry over unchanged. Only the mount differs: barrel count and arc.
2. **The mount type sets the arc.** A casemate has the most protection and a 120–145° sea sector. A turret is armoured with 360° on land. An open barbette has 360° and no roof. A railway gun has almost no arc.
3. **Land guns outrange ships of the same calibre.** That is the tier above `naval_xl`. Lindemann's light coast shell gives a 1.44× reach with battleship-level damage. A static battery should be able to hit a battleship before the battleship can reply, as Lindemann could reach Dover.
4. **The siege tier trades rate for mass.** One enormous, slow, area-effect shell every two minutes. Low sustained DPS, huge single hits, terrain/structure denial.
5. **Light guns cover the inshore gap.** The heavy guns are slow to slew. The Flak 88 and AMTB 90 mm fill the anti-small-craft role: 360°, 15–24 rpm, `naval_s`-like reach (ratio ~0.9–1.15). If the game wants an anti-fighter emplacement, the numbers would be about 30 damage, 180 ticks reload, `naval_s` reach.

## What the game deliberately doesn't copy

- **Gustav's real rate of fire and logistics.** 30–45 minutes per shot, three days to assemble and thousands of crew would make it unplayable. Reload is capped at 120 s, and set-up is not modelled (or becomes a construction time).
- **Separate shell loads.** Real coastal guns chose between AP, HE and light long-range shells. The game gives each emplacement one weapon. Lindemann's pairs the light shell's reach with the heavy shell's damage.
- **The ship doc's stated √ and ^0.75 laws literally.** The shipped catalogue fits a steeper damage curve (≈ w^0.81) and a linear reload curve. The new weapons follow what shipped so they slot in with the existing four.
- **Real barrel wear.** Lindemann's barrels lasted only about 200–300 shots. No ammunition or wear limit.
- **Exact casemate arcs.** Only the US 16" casemate figure (145°) was confirmed. 120° for the German casemates is a design value.
- **Fire control, spotting and plunging fire.** Range is flat reach, and there is no elevation or deck/belt armour model.

## Sources

- [40.6 cm/52 SK C/34, NavWeaps](http://www.navweaps.com/Weapons/WNGER_16-52_skc34.php): shell weights incl. Adolph coast shell, 43/56 km ranges, ~2 rpm, coast mount elevation and train
- [28 cm/54.5 SK C/34, NavWeaps](http://www.navweaps.com/Weapons/WNGER_11-545_skc34.php): 315–330 kg, 40.9 km, 3.5 rpm, Drh LC/34 turret ±150° at 7.2°/s, Gneisenau turret at Austrått
- [Austrått Fort, Wikipedia](https://en.wikipedia.org/wiki/Austr%C3%A5tt_Fort)
- [16"/50 Mark 2 and 3 (incl. M1919 comparison), NavWeaps](http://www.navweaps.com/Weapons/WNUS_16-50_mk2.php): M1919 49,140 yd at 48°, coast-defence 1 rpm note
- [16-inch/50-caliber M1919 gun, Wikipedia](https://en.wikipedia.org/wiki/16-inch/50-caliber_M1919_gun): barbette 360°, casemate 145°, elevation −7° to +65°, 44.9 km
- [Battery Townsley, NPS](https://www.nps.gov/goga/learn/historyculture/battery-townsley.htm); [Battery Townsley, militarymuseum.org](https://militarymuseum.org/BtyTownsley.html)
- [24 cm SK L/40, Wikipedia](https://en.wikipedia.org/wiki/24_cm_SK_L/40): 140–151 kg, 26.6 km at +46°, 3 rpm, coast mount ±150°
- [Hamburg battery – Stp 234, D-Day Overlord](https://www.dday-overlord.com/?p=136178): four casemated 240 mm guns, 25 km, the 25 June 1944 duel
- [Dover Strait coastal guns, Wikipedia](https://en.wikipedia.org/wiki/Dover_Strait_coastal_guns); [Coastal gun battery Lindemann, battlefieldsww2.com](https://battlefieldsww2.com/coastal-gun-battery-lindemann.html) (shells 2,250 / 1,300 lb, concrete up to 4 m, 2,200+ rounds); [Lindemann, bunkersite.com](https://bunkersite.com/locations/france/calais/sangatte/lm.php)
- [Schwerer Gustav, Wikipedia](https://en.wikipedia.org/wiki/Schwerer_Gustav): 4.8 t HE / 7.1 t AP, 47 / 38 km, 820 / 720 m/s, 14 rounds a day, 12 m crater
- [41 cm/45 3rd Year Type naval gun, Wikipedia](https://en.wikipedia.org/wiki/41_cm/45_3rd_Year_Type_naval_gun): Iki, Tsushima and Pusan coast turrets
- [5"/38 Mark 12, NavWeaps](https://navweaps.com/Weapons/WNUS_5-38_mk12.php): Mk 38 twin train 25°/s, elevation 15°/s, 15–22 rpm
- [Bofors quad (model review notes on practical rate of fire)](https://modelwarships.com/reviews/misc/Black_Cat_Models/72001-40mm_72nd/40mm_72nd.html); [Bofors 40 mm gun, Wikipedia](https://en.wikipedia.org/wiki/Bofors_40_mm_gun)
- [8.8 cm Flak 18/36/37/41, Wikipedia](https://en.wikipedia.org/wiki/8.8_cm_Flak_18/36/37/41)
- [90 mm gun M1/M2/M3, Wikipedia](https://en.wikipedia.org/wiki/90_mm_gun_M1/M2/M3): AMTB battery composition
