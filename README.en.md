# Lakeside Fishing
### 湖畔のフィッシング

English | **[日本語](README.md)**

**Cast a line into the dawn-lit lake, and wait.**  
They say the *Lord of the Lake* still sleeps in its deepest waters.

### ▶ [Play in your browser](https://teitasan.github.io/lakeside-fishing/)

No installation needed — everything runs in the browser. Sound on. Best with a mouse on desktop.  
Available in **Japanese / English** (switch from the title screen or the in-game menu). Choose **Play Together** on the title screen to share a lake with friends (multiplayer goes through the Cloudflare Worker; the Worker URL is not public—anyone who knows it may join).

![Lakeside Fishing](docs/screenshot.png)

<p>
<img src="docs/firstperson.png" width="32.5%" alt="First person">
<img src="docs/underwater.png" width="32.5%" alt="Underwater camera">
<img src="docs/journal.png" width="32.5%" alt="Journal">
</p>
<p>
<img src="docs/cast.png" width="49%" alt="Casting">
<img src="docs/fight.png" width="49%" alt="Fight">
</p>

---

## What is this?

A 3D fishing game built around quiet angling: walk the lakeshore, pick your depth and bait, cast, and wait.

- **Aim and cast** — look down for short casts, level out for long ones. Release inside the green band to hit your mark
- **Location and depth matter** — shallows vs. deep water, surface vs. mid-column vs. bottom. Every fish has its own haunt
- **Fight by feel and sound** — hold to reel, give line when it runs. The rod bends and kicks with every move the fish makes
- **Journal and surveying** — collect fish and terrain; the map fills in only where you've walked or cast
- **A different lake every time** — seed-generated. Day/night and weather change what bites
- **Upgrade your gear** — rods, lines, baits. Higher tiers unlock as you level up

| | |
| --- | --- |
| Fish & critters | 30 species + 4 kinds of junk |
| Gear | 5 rods / 9 lines / 7 baits |
| Achievements | 9 |
| Perspective | First person + underwater camera |
| Languages | Japanese / English |

---

## How to play (in one breath)

1. **Aim with the mouse**, then press and release inside the green band to cast
2. Pick a depth layer (surface / mid / bottom) with **`E`**
3. When the bobber goes under, **click immediately** to set the hook
4. During the fight: **hold to reel** / **release to ease the tension**
5. Catches earn money and XP. `B` opens the shop, `Q` the journal

For detailed parameters and the simulator, see the [Parameter Guide](https://teitasan.github.io/lakeside-fishing/manual.html) (Japanese).

---

## Controls

| | |
| --- | --- |
| Look | Mouse (click to lock / Esc to release) |
| Move / sprint | `W` `A` `S` `D` / `Shift` |
| Cast · hook · reel | Click or `Space` |
| Depth layer | `E` |
| Journal / Shop / Map | `Q` / `B` / `M` |
| Underwater camera | `V` (while the rig is underwater) |
| Toggle UI / Menu | `U` / `Esc` |

You can switch the language from the title screen or the in-game menu.

---

## Tips

- Match water depth with the right layer. The `E` panel lists "fish that bite here"
- Big fish will snap an underpowered line. Lines = strength; rods = reeling power and stamina
- Night, rain, deep water, premium bait. The rumored **Lord of the Lake** and the **Taimen (Itou)** are waiting there
- Use "Take a Break" in the menu to advance time by one hour

---

## Running locally

```bash
./serve.sh
# or: python3 -m http.server 8000
```

Open `http://localhost:8000`. It won't run from `file://`. A WebGL2-capable browser is recommended.
**Single-player only** on a static server. Use the Worker below for multiplayer.

### Multiplayer Worker (Node.js 22 recommended)

```bash
npm install
npm run dev:mp
# or: npx wrangler dev --local --persist-to /tmp/lakeside-fishing-wrangler-state
```

Open `http://localhost:8787` and choose **Play Together** on the title screen.
Locally, the client and Worker share the same origin, so no `MP_ORIGIN` injection is needed.

```bash
node scripts/run-tests.mjs
node scripts/run-mp-protocol-test.mjs
```

---

## Deployment architecture

| Role | Host | Serves |
| --- | --- | --- |
| Single-player | [GitHub Pages](https://teitasan.github.io/lakeside-fishing/) | Static HTML / JS / assets |
| Multiplayer | Cloudflare Worker | WebSocket `/ws`, voice `/api/voice/join` |

Pushes to `main` deploy GitHub Pages and the Worker independently.

### GitHub Pages (static site)

- Workflow: `.github/workflows/deploy-pages.yml`
- Project-site base path: `/lakeside-fishing/` (relative `./` paths resolve correctly)
- Set GitHub Actions **secret** **`MP_ORIGIN`** to the origin of the existing multiplayer Worker. The deploy step injects it into `<meta name="lakeside-mp-origin">` in `index.html`. **Never commit a real production Worker URL to the repository, README, or tracked source.**
- When unset, the client falls back to same-origin (local Worker dev).

### Cloudflare Worker (multiplayer only)

- Workflow: `.github/workflows/deploy-cloudflare.yml` (`wrangler deploy --env production`)
- Does not serve static assets — only `/ws` and `/api/voice/join`.
- Security is **URL obscurity**: anyone who knows the Worker URL may join. There is no Cloudflare Access or JWT verification.

Production Worker variables (`env.production.vars` in `wrangler.jsonc` or the dashboard):

| Variable | Purpose |
| --- | --- |
| `CORS_ORIGINS` | GitHub Pages origin (e.g. `https://teitasan.github.io`) for cross-origin voice API |

Secret: `REALTIMEKIT_API_TOKEN` (via `wrangler secret put`, as before).

---

## Credits

- Angler & rod models: [Quaternius](https://quaternius.com/) (CC0)
- Engine: Three.js (bundled in-repo, no external requests)
- Post-processing: [postprocessing](https://github.com/pmndrs/postprocessing) (bundled in-repo)

Single-player → [teitasan.github.io/lakeside-fishing](https://teitasan.github.io/lakeside-fishing/)
Multiplayer Worker → injected via GitHub Actions secret `MP_ORIGIN` (not stored in the repo)
