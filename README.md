# A Goose Among Sirens

A Jackbox-style party game where friends get together, show off their music taste, and introduce each other to new songs.

One screen (a TV or laptop with good speakers) is the **host**. It shows the prompts, plays the songs, and runs an animated WebGL scene: sirens singing from their rocks while a goose bobs, unbothered, on the waves. Everyone else plays on their **phones**, with no app to install. Players answer prompts with songs, then guess, judge or vote. The rules and every prompt come from `A Goose Among Sirens.docx`.

---

## Quick start

You need [Node.js](https://nodejs.org) 18.17 or newer. There are no dependencies, so you don't need to run `npm install`.

```bash
npm start
```

The terminal prints two addresses:

```
  Host screen (TV / laptop):  http://localhost:3000/host
  Players join on phones:    http://192.168.1.23:3000
```

1. Open **`/host`** on the computer connected to the speakers. A room code and a QR code appear. Press **F** for fullscreen.
2. Everyone scans the QR code or opens the phone address. Phones must be on the **same Wi-Fi** as the host. Each player enters the room code and a name.
3. Pick a game mode on the host screen and press **Start**. The host advances the game with the big yellow button, or with **Enter / N**.

Options:

| Option | What it does |
|---|---|
| `PORT=8080 npm start` | Changes the port |
| `npm run dev` | Restarts the server when you edit code |
| `PERSIST=0` | Turns off saving rooms to disk |
| `DATA_DIR=/some/path` | Changes where rooms are saved (default `./data`) |

---

## Game modes

All three modes accept **2–12 players** (3+ is the real party experience; fewer is handy for testing or demos). King Goose needs at least 2. The host screen is not a player.

### 🪿 A Goose is Loose!
Each player gets **3 random prompts** (1–3, adjustable in the lobby) and can **swap up to 2** they don't like for new ones before answering, such as *"What song should be playing when you inevitably take over the world?"*, and answers each with a song.

When everyone is done, all the songs are shuffled and played one at a time. The host screen shows the prompt that the song's owner (the "Goose") was answering. Everyone else guesses on their phone who picked it.

- **+1** for each correct guess.
- After each reveal, the Goose gets a moment to explain their pick. The host presses **Next song** when everyone is ready.

### 👑 King Goose
Players take turns as **King Goose**. Each turn, the King gets a ridiculous scenario, like *"King Goose enjoys a balanced breakfast"*, and everyone else picks a soundtrack for it.

The soundtracks play **anonymously**. Then the King crowns a favorite on their phone, and that player gets **+1**. Everyone is King once by default (up to 3 times each).

### 🤫 Secret Goose
Every player gets the same one-word **feeling**, such as *Nostalgia* or *Spite*, except the **Secret Goose**, who picks a song blind.

1. **Listen:** the songs play anonymously.
2. **Defend:** the feeling and who picked what are revealed. Everyone argues that their song fits, and the Goose bluffs.
3. **Vote:** everyone votes for who they think the Goose is.

The design doc doesn't give scoring for this mode, so we use these house rules:
- **+1** to every player who votes for the Goose.
- **+2** to the Goose if a majority doesn't vote for them.

The Goose rotates each round. The default is 3 rounds, adjustable up to 12.

---

## Party features

- **Song of the Night.** When the game ends, everyone hearts their favorite song on their phone. Their own songs don't count, and tapping again removes the heart. The TV shows the live winner along with who picked it.
- **Late joiners join the audience.** Anyone who arrives mid-game, or after all 12 seats are taken, joins as audience. Audience members see what the TV shows, can send reactions and heart songs at the end, and get seated automatically when the next game starts. Their secret prompts never leak, because audience members only receive public info.
- **Family mode** (lobby toggle) leaves out the crude and dark built-in prompts, such as the nipples, condom, cyanide and swamp-ass scenarios. Custom prompts are never filtered.
- **Prompt packs.** Add a built-in bonus pack (*Road Trip*, *Holiday Party*, *Birthday*, *Office Party*, *Summer Cookout*) with one click. You can also **Export** your custom prompts as a JSON file and **Import** it at the next party.
- **Link preview.** When a player pastes a link, the phone looks up the actual track title ("🎵 Rick Astley – Never Gonna Give You Up") or flags a broken link, before they lock it in.

- **Goose avatars.** Every player gets a goose with a collar in their color and a hat: crown, top hat, party hat, beanie, flower, headphones, shades, bow tie or cowboy hat. Players change hats from their phone in the lobby. New geese waddle onto the host's lobby screen as they join.
- **Title cards and score animations.** Big cards announce each round ("All hail King Bartholomew"), judging, voting and the finale. Scoreboard rows slide when ranks change, and points pop up as "+1".
- **Sound effects** on the host screen, all synthesized in the browser with no audio files: a honk for HONK! reactions and caught geese, chimes on reveals, a fanfare for crownings and the finale, and ticks in the last 5 seconds of a timer. Mute with the 🔊 button.
- **End-of-game awards.** These are given only when earned. Ties share an award, but an award everyone ties for is skipped.

  | Award | Goes to |
  |---|---|
  | Sharpest Ears | Most correct guesses |
  | Master of Disguise | Fooled the most guessers |
  | Royal Favorite | Crowned the most times |
  | Smooth Bluffer | Escaped as the Secret Goose |
  | Goose Detective | Caught the Goose the most |
  | Hype Goose | Sent the most reactions |
  | Crowd Pleaser | Picked the most-reacted song |

- **End-of-game setlist.** When the game ends, the host screen lists every song that was played, who picked it and the prompt it answered. It has a **Play all on YouTube** button (an instant, account-free YouTube playlist) and **Copy setlist**. Each phone gets a *Songs you discovered tonight* list of the other players' picks with links, so everyone takes home new music.
- **Live reactions.** While songs play, phones show 🔥 😂 😭 🤯 💀 ❤️ and **HONK!** buttons, and each tap floats up through the WebGL scene on the TV. HONK! also makes the goose hop. Each player is limited to about 3 reactions a second.
- **Optional timers** (*Timers: On* in the lobby):

  | Phase | Time limit |
  |---|---|
  | Picking songs | 75 s per song owed |
  | Guessing | 30 s |
  | King's judging | 45 s |
  | Voting | 40 s |

  When time runs out, the game moves on without stragglers. The host can press **+30s** at any time. The countdown follows the server's clock, so phones stay in sync.
- **Custom prompts.** In the lobby, the host can add custom prompts, King Goose scenarios or Secret Goose feelings for the selected mode. Players can suggest them anonymously from their phones while they wait. Custom prompts are dealt **before** the built-in ones.

---

## Playing on phones (and hosting from one)

- **Any modern phone browser works:** iOS Safari 15+, Chrome and Firefox on Android. Layouts were tested at 320 px (iPhone SE), 390 px, landscape and tablet sizes.
- **Installable:** players can use *Add to Home Screen* to get a full-screen app with its own icon.
- **Connections that survive phone life:** if a phone sleeps, switches apps or drops Wi-Fi, it reconnects automatically when it comes back. A server heartbeat catches connections that died silently. While a phone is disconnected, a "Reconnecting…" banner shows.
- **Haptics:** phones buzz when it's time to pick, judge or vote, and on reveals.
- **Hosting from a tablet or phone works too**, for example with a Bluetooth speaker. The host screen switches to a single column and keeps the main button pinned at the bottom.
- **Host keyboard shortcuts:** **Enter** or **N** advances the game, and **F** toggles fullscreen.

---

## How songs play

Players can submit any of these:

| Input | Example | On the host screen |
|---|---|---|
| YouTube / YouTube Music link | `https://youtu.be/dQw4w9WgXcQ?t=43` | Embedded player that autoplays and keeps any `?t=` start time |
| Spotify link or URI | `https://open.spotify.com/track/…` | Embedded Spotify player |
| Plain text | `Toxic – Britney Spears` | Title plus one-click **Search YouTube / Spotify** links |

Each phone has **YouTube Music ↗ / Spotify ↗** buttons that search for whatever the player typed, so they can grab a link quickly. The server looks up real track titles through the public oEmbed endpoints, and the title replaces the raw link on screen a moment after submission.

**Limitations**
- **Spotify embeds play 30-second previews** unless the host browser is logged in to Spotify. In that case they play the full track.
- **Some YouTube videos block embedding.** Official label uploads are the usual culprit. The host shows an *"Open on YouTube"* link as a fallback, and lyric videos or "topic" uploads almost always embed fine.
- Browsers may block autoplay until someone has clicked on the host page once. Clicking **Start** counts.
- The Spotify Web API would allow true playback control, but it requires a developer app, OAuth and a Premium account. The design doc asks only that the songs actually play, so embeds keep setup at zero.

---

## How it's built

```
server.js            Node HTTP server, no dependencies: static files, JSON API, live updates over SSE
src/game.js          The game: one state machine per room covering all three modes, plus per-viewer views
src/media.js         Parses YouTube/Spotify links and plain text; looks up titles via oEmbed
src/prompts.js       Every prompt and scenario from the design doc
public/host.html     Big screen: js/host.js (UI + music), js/scene.js (WebGL), js/sfx.js (Web Audio)
public/play.html     Phone controller: js/play.js
public/css/style.css Shared styles
test/game.test.js    Engine tests: full games of every mode, secrecy checks, link parsing
test/features.test.js  Timers (fake clock), custom prompts, reactions, setlist, hats, awards,
                       audience, Song of the Night, family mode, packs, save/restore
```

- **Server-authoritative.** All rules live in `src/game.js`. Phones and the host only send intents such as `submit`, `guess`, `judge`, `vote` and `next`.
- **Secrets stay secret.** `Room.view(playerId)` builds a separate state for every screen. The public host screen never sees a song's owner before the reveal, and it never sees the Secret Goose's feeling before the defend phase. The Goose's own phone never sees the feeling either. Tests cover all of this.
- **Live updates** use Server-Sent Events with automatic reconnect. If a phone sleeps or someone refreshes, they rejoin automatically (the session is kept in `localStorage`).
- **Reactions** are not part of the game state. The server forwards them as a separate SSE event to the host screen only. On the host, they're drawn as point sprites from an emoji texture atlas that is rendered at runtime.
- **Timers** live on the server (`Room.syncTimer`). Each phase gets a key, and a timer only fires if its phase is still current, so a stale timer can never skip ahead. Tests use a fake clock.
- **The WebGL scene** (`public/js/scene.js`) is raw WebGL 1 with no libraries:
  - A full-screen fragment shader draws the sky, stars, a striped sun, two rocks with siren silhouettes, layered waves, and a goose that rides the swell.
  - A `gl.POINTS` particle system draws music notes while a song plays and feather bursts on reveals, crownings and the finale.
  - Each mode has its own palette: sunset for *Goose is Loose*, royal gold for *King Goose*, moonlit night for *Secret Goose*.
  - Resolution drops automatically on slow machines.
- **Rooms survive restarts.**
  - Every change is saved, debounced, to `data/rooms.json`. The file is written atomically, and it's saved again on Ctrl+C.
  - On startup the server restores every room less than 6 hours old, and all screens reconnect to the same game where it left off.
  - A running countdown restarts from full time.
  - `Room.toJSON()` / `Room.fromJSON()` handle saving and loading, and a test covers a mid-game round trip.

### Tests

```bash
npm test
```

---

## Ideas / next steps
- Show reactions as tiny goose avatars flying across the WebGL scene, instead of emoji only.
- Let players **pick their prompts** (for example, choose 3 of 5), building on prompt swaps.
- **Spotify Web Playback SDK** support for full-track playback when the host has Premium.
- A **"best pick" vote** at the end, with a bonus for the song everyone loved most.
