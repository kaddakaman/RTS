# Shatterfront

A real-time strategy game for Android phones, built to be played with a **controller** (Halo Wars-style controls), with full touch and keyboard/mouse support too. Two very different factions fight with rock-paper-scissors counters, and a neutral third faction sits on the riches in between. Up to four sides can play against the computer, or online between two phones.

- **Earth Coalition**: tough, well-armoured human forces.
- **Sythari Ascendancy**: fast alien raiders with plasma and beam weapons, but thinner armour. Equal armies trade evenly.
- **Marauders**: scavengers who hold any base nobody plays (and, optionally, an outpost on the central hoard). They shoot anyone who walks into their territory, and send a raid party after anyone who attacks them, but never go looking for trouble.

## Install it on your Android phone

1. On your phone, open **https://github.com/kaddakaman/RTS/releases/latest** in Chrome.
2. Under **Assets**, tap **Shatterfront.apk** to download it.
3. Open the download and tap **Install**. If the phone says it can't install apps from this source, tap **Settings**, turn on **Allow from this source**, then go back and tap **Install**. If Google Play Protect warns about an unrecognised app, tap **More details**, then **Install anyway**.
4. Open **Shatterfront** from your app drawer. It always plays in landscape, full screen. Pair a Bluetooth controller (Xbox, PlayStation, or any standard Android gamepad) for the best experience.

To update, repeat the same steps; the new version installs over the old one.

### How the APK gets built

Every time the code changes on GitHub, GitHub's servers build a fresh `Shatterfront.apk` and put it on the Releases page (see `.github/workflows/android.yml`). Each build takes about five minutes and you can watch it under the repository's **Actions** tab.

**The signing key.** Updates only install over an existing copy if every version is signed with the same key. That key is stored **encrypted** in `android/app/rts-release.jks.enc`, and GitHub unlocks it with a repository secret named `KEYSTORE_PASSWORD`. To set it up (once):

1. On GitHub, open the repository, then **Settings → Secrets and variables → Actions**.
2. Tap **New repository secret**. Name: `KEYSTORE_PASSWORD`. Secret: the password you were given. Tap **Add secret**.
3. Go to **Actions → Build Android APK → Run workflow**.

Until the secret exists, the build still works, but it signs each APK with a throwaway key, so you have to uninstall the old version before installing a new one. Keep a private copy of the password: if it's lost, a new key is needed and everyone has to reinstall once.

## Play in a browser (for testing)

```bash
npm install
npm run dev        # then open the printed address
```

## How to play

**Win** by destroying every enemy HQ. Lose your HQ and you're out (in team games your team carries on while any ally still has an HQ).

### Economy
- You start with an HQ, one builder and one supply truck next to your **main supply cache** (enough for roughly the first ten minutes or so with a few trucks).
- **Supply trucks** carry supplies from caches to your HQ or a Supply Depot. Caches run dry, so expand to the other caches around the map.
- A **Supply Drop Zone** gives income that never runs out: the Coalition's cargo plane air-drops crates, and the Sythari teleport supplies down from orbit.
- Destroying a Marauder stronghold pays a bounty and frees up the supplies it was guarding.

### Building and tech
The builder (Engineer Dozer / Shaper Drone) constructs everything:

| Building | Needs | What it does |
|---|---|---|
| HQ | - | Builds builders; upgrades to Tier 2/3/4 (each tier raises the unit cap) |
| Barracks | - | Infantry; Field Medic upgrade (Tier 2) |
| Supply Depot | near a cache | Supply trucks (comes with one free) |
| Fortifications Yard | Barracks | Unlocks the defences below |
| Vehicle Depot | Tier 2 | Scout, light combat vehicle, battle tank, transport |
| Air Base | Tier 3 | Gunship, bomber, dropship; bombers rearm here |
| Supply Drop Zone | Supply Depot | Passive income |
| Superweapon | Tier 4 | Orbital Strike / Singularity Lance, recharges every 4 minutes |
| Gunner Emplacement | Fort. Yard | An infantry squad inside deals +50% damage, gains range and is protected |
| SAM Site | Fort. Yard | Anti-air only |
| Artillery | Fort. Yard + Tier 2 | Long range, deadly to vehicles |

### Units and counters

| Role | Coalition | Sythari | Strong vs | Weak vs |
|---|---|---|---|---|
| General infantry (5-man squad) | Rifle Squad | Vanguard Strikers | Anything, a little | Snipers, tanks, light vehicles |
| Counter-infantry (2-man team) | Sniper Team (sniper + spotter) | Beam Lancers | Infantry (can't hit anything else) | Vehicles, aircraft |
| Anti-vehicle (2-man team) | Rocket Team (gunner + loader) | Plasma Cannon Team | Tanks, vehicles, aircraft | Infantry |
| Scout (unarmed, fast, sees far) | Pathfinder | Seeker Skiff | Intel | Everything |
| Light combat vehicle | Hound Gun Jeep | Glaive Skimmer | Infantry | Tanks |
| Main battle tank | Bulwark | Tremor Grav-Tank | Infantry, vehicles, buildings | Anti-vehicle infantry, gunships |
| Transport (2 squads) | Mule | Phase Carrier | Moving infantry fast | Everything |
| Bomber (one run, then rearms) | Hammerhead | Talon Striker | Buildings, vehicles | Anti-air |
| Gunship (stays airborne) | Hornet | Shrike | Vehicles | Anti-air, rocket teams |
| Air transport (2 squads) | Albatross Dropship | Veil Lifter | Drops over cliffs and behind lines | Anti-air (passengers die if it's shot down) |

Unit abilities (Y / Ability button): rifle squads throw grenades, scouts fire a recon pulse, light vehicles boost, transports unload, bombers return to rearm.

### Upgrades
Every unit type has an upgrade (the Sythari versions have their own names):

| Researched at | Upgrade | Effect |
|---|---|---|
| Barracks | Field Medics | Rifle squads get a medic: an extra member and healing out of combat |
| Barracks | Spotter Optics | Snipers: +4 vision, +1 range |
| Barracks | Speed Loading | Rocket teams reload about 50% faster |
| Vehicle Depot | Active Protection | Tanks shoot down one incoming rocket or plasma bolt every 4 seconds |
| Vehicle Depot | Composite Plating | Light combat vehicles: +30% health |
| Vehicle Depot | Long-Range Sensors | Scouts: +3 vision, recon pulse recharges twice as fast |
| Vehicle Depot | Reinforced Hull | Transports: +25% health and room for a third squad |
| Air Base | ECM Jammers | All aircraft: 40% of guided missiles, rockets and plasma bolts lose their lock and miss |
| Supply Depot | Armoured Cabs | Supply trucks: +50% health |
| HQ | Rapid Construction | Builders build and repair 40% faster |

Builders repair damaged buildings near them by themselves when idle, or you can order a repair: select the builder and press X (or tap) on the building.

### The map: Ember Basin
A four-base desert map. Each base sits on a plateau with a wide **main ramp** facing the middle and a narrow **side ramp** facing a corner: two chokepoints to hold. You can always see the whole map, but enemy units and buildings only appear where your own units and buildings have line of sight. Units below a cliff can't see what's on top, scrub forests hide infantry (vehicles can't enter them), and rocks block sight. Aircraft see and fly over everything, so watch your cliff edges for drops. Supply caches sit in each base, outside each ramp, in the fields between bases and in every corner, and there's a big hoard on the raised centre, which is ringed by a moat with four crossings.

### Game modes
**Skirmish** (one phone): you plus 1-3 AI players (Easy / Normal / Hard), on any teams: 1v1, 2v2 with an AI ally, or free-for-all. In a 1v1, the two empty bases are taken over by the Marauders.

**Online** (two phones, internet needed): one player hosts and gets a five-letter room code, the other joins with it. You can play against each other (each optionally with an AI team-mate), together against two AIs, or any other mix. The host's phone runs the battle; a free public matchmaking server introduces the two phones, and the game data then travels directly between them. If a player disconnects, the AI takes over their base.

## Controls

### Controller (Halo Wars style)
| Button | Action |
|---|---|
| Left stick | Move the reticle around the screen (push it into an edge to scroll the map) |
| Right stick | Scroll the map (click: zoom in / normal / out) |
| A | Select (hold to paint-select, double-tap for all of that type on screen) |
| X | Command: move, attack, gather, build/repair, board, man an emplacement, depending on the target |
| Y | Unit ability, or the **build menu** when builders are selected |
| B | Cancel / deselect / back |
| LB | Army on screen (double-tap: whole army) |
| RB | Cycle unit types within your selection |
| LT | Zoomed-out tactical view |
| RT | Fire the superweapon |
| D-pad | ▲ HQ · ▼ army · ◀ latest alert · ▶ next production building |
| Start / Back | Pause menu / battle report |

Selecting a building opens a radial menu: point the stick and press A to queue; X cancels the last item. Busy buildings keep their unit upgrades in an "Upgrades" sub-menu. With a building selected, X on the ground sets its rally point.

### Touch
Drag to scroll, pinch to zoom, tap to select, tap the ground / an enemy / a cache to give orders, tap your gunner emplacement with a squad selected to man it (or a damaged building with a builder selected to repair it), long-press and drag to paint-select, double-tap a unit for all of that type. On-screen buttons cover the controller actions, and you can tap the minimap to jump there.

### Keyboard and mouse
Left click / drag to select, right click to command, WASD or arrows to scroll, wheel to zoom, Q ability, B build, E army, Tab unit types, H HQ, G alert, P buildings, R superweapon, Z tactical zoom, Esc cancel/pause.

## Development

```bash
npm run dev        # dev server
npm test           # unit tests, balance duels, online-play tests and full AI-vs-AI matches
npm run build      # type-check + production build into dist/
npx cap sync android && (cd android && ./gradlew assembleRelease)   # local APK (needs the Android SDK)
```

Open the dev server with `?net=local` to test online play between two tabs of the same browser without the internet.

```
src/
  data/     factions, units, buildings, upgrades, damage table (all the numbers live here)
  sim/      the simulation: map, path finding, combat, economy, fog of war, AI, Marauders, commands
  render/   procedural terrain, unit and building art, effects, fog overlay
  input/    gamepad / keyboard state
  ui/       controller scheme, HUD, radial menus, menus and lobby
  net/      online play: transports (WebRTC via PeerJS), lobby/session, snapshots
tests/      vitest suites
android/    the Android app (Capacitor) that wraps the game into an APK
```

All art and sound is generated in code; there are no asset files.
