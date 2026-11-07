# WW2 surface combatants: the reference for capital ships

R&D for the capital-ship plan (`eager-sauteeing-curry`, branch `rnd/capital-ships`). It records what real WW2 warships measured, which ratios the game copies, and which it doesn't. Figures are from secondary sources (Wikipedia, NavSource / ibiblio HyperWar, DANFS, NavWeaps, Friedman via destroyerhistory.org), listed at the end. Where sources disagree, the commonly cited value is used and the range noted.

## The ships

| Class | Ship (navy) | Length o/a × beam | Displacement std / full | Power | Top speed | Main battery |
|---|---|---|---|---|---|---|
| Destroyer | Fletcher (US) | 114.7 × 12.1 m | 2,100 / 2,924 t | 60,000 shp | 35–36.5 kn | 5 × 5"/38 (single), 10 × 21" torpedoes |
| Destroyer | Fubuki (IJN) | 118.4 × 10.4 m | 1,750 / 2,050 t | 50,000 shp | 35–38 kn | 6 × 12.7 cm (3 twin), 9 × 61 cm torpedoes |
| Light cruiser | Cleveland (US) | 186 × 20.2 m | 11,744 / 14,131 t | 100,000 shp | 32.5 kn | 12 × 6" (4 triple), 12 × 5" (6 twin) |
| Heavy cruiser | Baltimore (US) | 205.3 × 21.6 m | 13,600–14,500 / 17,000 t | 120,000 shp | 33 kn | 9 × 8" (3 triple) |
| Heavy cruiser | Takao (IJN) | 203.8 × 20.4 m | 9,850 / 15,490 t | 132,000 shp | 34–35.5 kn | 10 × 20 cm (5 twin) |
| Large cruiser | Alaska (US) | 246.4 × 27.8 m | 29,771 / 34,253 t | 150,000 shp | 31.4–33 kn | 9 × 12" (3 triple) |
| Battlecruiser | Scharnhorst (KM) | 234.9 × 30 m | 32,100 / 38,100 t | 160,000 shp | 31.5 kn | 9 × 28 cm (3 triple) |
| Battleship | Iowa (US) | 270.4 × 33 m | 48,110 / 57,540 t | 212,000 shp | 33 kn | 9 × 16" (3 triple), 20 × 5" |
| Battleship | Bismarck (KM) | 251 × 36 m | 41,700 / 50,300 t | 148,000 shp | 30 kn | 8 × 38 cm (4 twin) |
| Battleship | Yamato (IJN) | 263 × 38.9 m | 64,000 / 72,800 t | 150,000 shp | 27 kn | 9 × 46 cm (3 triple) |

Turning, where documented: Fletcher had a 950 yd (869 m) tactical diameter at 30 kn, and its single rudder was a known weak point. Iowa had 814 yd (744 m) with twin rudders (one secondary source).

## The ratios that matter (destroyer = 1, US ships, full load)

| | Destroyer | Light cruiser | Heavy cruiser | Large cruiser | Battleship |
|---|---|---|---|---|---|
| Length | 1 | 1.62 | 1.79 | 2.15 | 2.36 |
| Beam | 1 | 1.67 | 1.79 | 2.30 | 2.73 |
| Length : beam | 9.5 | 9.2 | 9.5 | 8.9 | 8.2 |
| Displacement | 1 | 4.8 | 5.8 | 11.7 | 19.7 |
| Power-to-weight (shp / t) | 20.5 | 7.1 | 7.1 | 4.4 | 3.7 |
| Top speed | 1 | 0.89 | 0.90 | 0.89 | 0.90 |
| Main gun calibre | 5" | 6" | 8" | 12" | 16" |

### What the game takes from this

1. **Big ships are not much slower; they are slower to change speed.** Top speed is almost flat (27–37 kn, with 31–33 kn typical). Power-to-weight falls more than 5× from destroyer to battleship. That sets **acceleration**: a battleship takes about 5× longer than a destroyer to reach the same speed.
2. **Turning circles are similar in metres, so big ships are relatively nimble for their length but sluggish to respond.** A destroyer circles in about 7.5 of its own lengths, a battleship in about 2.75. Steady turn rates (degrees per second) end up in the same range. What differs is how long a big hull takes to *start* and *stop* turning (rotational inertia, rudder area). The game models this as angular acceleration falling with mass, with a modest drop in top turn rate.
3. **Long and thin, with beam growing faster than length.** Every class is 8–9.5 times as long as it is wide. Top-down, capitals read as long blades, not wedges.
4. **Armament scales by calibre, not by count.** Main-gun counts stay around 8–12, while calibre rises 5" → 16" (shell weight rises about 25×). That maps onto **mount sizes**:
   - 5" ≈ S (destroyer main, everyone's secondaries);
   - 6–8" ≈ M (cruisers);
   - 12" ≈ L (large cruiser);
   - 16"+ ≈ XL (battleship).

   Secondaries and AA are many S mounts on the beam.
5. **Layout pattern (top-down):**
   - main turrets on the centreline in superfiring pairs: two forward, one or two aft;
   - superstructure and bridge just forward of midships;
   - one or two funnels mid-length, which become heat-sink stacks in space;
   - secondary turrets along both beams;
   - a fine bow taper over the forward ~15%, a fuller squared or rounded stern.
6. **Roles:**
   - **Destroyers:** fast, fragile, many light guns plus torpedoes; screen bigger ships.
   - **Cruisers:** balanced; escort or lead squadrons.
   - **Large cruisers and battlecruisers:** speed with heavy guns, light armour for their size.
   - **Battleships:** slow to manoeuvre, heaviest guns and armour, the fleet's centre.

### Guns (Phase 3 naval weapons)

Standard figures for the five calibres (NavWeaps):

| Gun | Shell | Max range | Rate of fire | Game weapon |
|---|---|---|---|---|
| 5"/38 | 25 kg | 16.6 km | 15 rpm | `naval_s` |
| 6"/47 | 59 kg | 24 km | 10 rpm | `naval_m` |
| 8"/55 | 152 kg | 27 km | 4 rpm | `naval_m` |
| 12"/50 | 517 kg | 35 km | 2.7 rpm | `naval_l` |
| 16"/50 | 1,225 kg | 38.7 km | 2 rpm | `naval_xl` |

The game keeps the range ratio (1 : 1.54 : 2.12 : 2.34). Damage follows the square root of shell weight (1 : 2 : 4.5 : 7), and reload follows rate of fire to the 0.75 power. Both are compressed so one salvo hurts without deleting a ship. Shells take about 2 s to reach full range, so a fighter can dodge them.

### What the game doesn't copy

- **Absolute speeds and distances.** 33 kn is 17 m/s. The game keeps the *ratios* and sets two anchors (a destroyer's length in game units, and its top speed) in `capitalReference.ts`, so the whole class tunes together.
- **Sea-going details:** draft, freeboard, screws, rudders. Thrust comes from stern engine blocks sized by the power ratio.
- **Aircraft and carriers.** Essex (267 × 28 m, about 36,400 t, 33 kn, about 90 aircraft) is noted as a later "carrier" role. It isn't in this round.

## Sources

- [USS Fletcher (DD-445), Wikipedia](https://en.wikipedia.org/wiki/USS_Fletcher_(DD-445)); [HyperWar DD pages (NHHC data)](https://www.ibiblio.org/hyperwar/USN/ships/DD/DD-555_Haggard.html); [Fletcher class, destroyerhistory.org (Friedman data, tactical diameter)](https://destroyerhistory.org/fletcherclass/index.asp?pid=200)
- [Fubuki-class destroyer, Wikipedia](https://en.wikipedia.org/wiki/Fubuki-class_destroyer)
- [USS Cleveland (CL-55), Wikipedia](https://Www.wikipedia.org/wiki/USS_Cleveland_(CL-55))
- [Baltimore-class cruiser, Wikipedia](https://en.wikipedia.org/wiki/Baltimore-class_cruiser); [Baltimore V (CA-68), DANFS](https://www.history.navy.mil/research/histories/ship-histories/danfs/b/baltimore-v.html)
- [Takao-class cruiser, Wikipedia](https://en.wikipedia.org/wiki/Takao-class_cruiser)
- [Alaska-class cruiser, Wikipedia](https://en.wikipedia.org/wiki/Alaska-class_cruiser); [USS Alaska (CB-1), Wikipedia](https://en.wikipedia.org/wiki/USS_Alaska_(CB-1))
- [Scharnhorst-class battleship, Wikipedia](https://en.wikipedia.org/wiki/Scharnhorst-class_battleship)
- [Iowa-class battleship, Wikipedia](https://en.wikipedia.org/wiki/Iowa-class_battleship); [Iowa class (Battleships of WWII, PressReader: tactical diameter)](https://www.pressreader.com/uk/battleships-of-wwii/20230201/285525139747635)
- [Bismarck-class battleship, Wikipedia](https://en.wikipedia.org/wiki/Bismarck-class_battleship); [NavWeaps INRO Bismarck](https://navweaps.com/index_inro/INRO_Bismarck.php)
- [Yamato-class battleship, Wikipedia](https://en.wikipedia.org/wiki/Yamato-class_battleship)
