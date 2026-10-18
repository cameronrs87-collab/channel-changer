# Channel Changer: phone voting

Audience members scan a QR code on the big screen, get a TV remote on their phone with a 7-channel dial, and vote live. The show laptop counts the votes and switches the channel on the big screen when a channel holds a majority.

Everything runs on the show laptop. There are no accounts, nothing to install on phones, and no internet connection is needed.

## What you need

- A laptop (Windows, Mac or Linux) with **Node.js 18 or newer**. Download it free from nodejs.org.
- A Wi-Fi network that the laptop and the audience's phones all join (see *Network* below).
- The laptop connected to the projector or big screen.

## Starting the show

Don't open `screen.html` directly. The QR code and live votes come from the vote server, so the page only works when the server opens it.

1. Double-click the launcher in this folder:
   - **Windows:** `start.bat`
   - **Mac:** `start.command`. The first time, macOS may refuse to open it. Right-click it, choose **Open**, then **Open** again.
2. A window with the server's messages appears, and the big screen opens in your browser at **http://localhost:3000/screen** a moment later. If it doesn't open, type that address into Chrome or Edge yourself.
3. The first time, your computer may ask whether to allow incoming network connections. Choose **Allow**, or phones can't reach it.
4. Press **P** for projector view. The QR code sits in the corner of the screen.
5. Click **Sound on** once so the static burst plays when the channel changes.

Keep the server window open during the show. Close it (or press Ctrl+C in it) to stop.

You can also start it from a terminal in this folder with `node server.js`.

## Network

Phones must be on the same network as the laptop. The simplest reliable setup:

- **Bring your own Wi-Fi router** (a cheap travel router is ideal). Plug nothing into it, connect the laptop and put the network name and password on a card at the door or on screen. It doesn't need internet.
- **Venue or guest Wi-Fi** often blocks devices from talking to each other ("client isolation"). Test it at the tech rehearsal with your own phone. If phones can't open the link, use your own router.
- **A phone hotspot** works for small groups, but most hotspots cap connections at about 10 devices.

Some phones show "No internet connection" on a router without internet and may quietly switch to mobile data. If a phone can't open the link, tell people to choose "Stay connected" or turn off mobile data for a moment.

If the laptop is on more than one network, pick the right address in the **Audience join link** panel. The QR code updates to match.

## Online mode: phones on any connection (Cloudflare Tunnel)

Use this if you'd rather people vote on mobile data, or a mix of Wi-Fi and mobile data. The laptop needs a working internet connection for the whole show.

**One-off setup:** install Cloudflare's free `cloudflared` tool. No Cloudflare account is needed.
- **Mac** (with Homebrew): `brew install cloudflared`
- **Windows:** `winget install --id Cloudflare.cloudflared`
- Or download it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

**On show night:**
1. Start Channel Changer as usual (`start.command` / `start.bat`, or `node server.js`).
2. Open a **second** Terminal or Command Prompt window and run:
   ```
   cloudflared tunnel --url http://localhost:3000
   ```
3. After a few seconds it prints an address like `https://some-random-words.trycloudflare.com`. Copy it.
4. On the big-screen page, paste it into **Audience join link → Online address** and click **Use**. The QR code switches to the online address.
5. Keep both windows open during the show.

Things to know:
- The address changes every time you start the tunnel, so repeat steps 3–4 each show.
- Quick tunnels don't carry live streams, so phones check for updates about twice a second instead. It's still near-instant.
- Anyone given the link could vote from outside the room. For a small show this rarely matters, but don't post the link anywhere public.
- Host controls never work through the tunnel. They only work on the laptop at `http://localhost:3000/screen`.
- To go back to Wi-Fi only, click **Back to Wi-Fi** and close the tunnel window.

## Hosting it online (Render)

Run the server on a hosting service so it has a permanent web address. Phones can use any connection, and you run the big screen from any computer's browser. Nothing has to run on your laptop except a browser.

You need free accounts on **GitHub** (github.com, to hold the files) and **Render** (render.com, to run them).

**1. Put the files on GitHub**
1. Sign in to GitHub and click **New repository**. Name it `channel-changer`. Private is fine. Click **Create repository**.
2. On the next page, click the link **uploading an existing file**.
3. Open your unzipped `channel-changer` folder and drag **everything inside it** onto the page: `server.js`, `package.json`, `render.yaml`, and the `lib`, `public` and `hardware` folders. `server.js` must sit at the top level, not inside another folder.
4. Click **Commit changes**.

**2. Create the service on Render**
1. Sign in to Render (you can sign in with GitHub). Click **New → Web Service** and connect your `channel-changer` repository. If it isn't listed, allow Render to see it when GitHub asks.
2. Fill in:
   - **Language/Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
3. Under **Environment Variables**, add:
   - `HOST_PASSWORD`: a password only you (and your crew) know. Make it something hard to guess.
   - Optional: `CHANNEL_NAMES`, your seven names separated by commas, e.g. `News,Cooking,Soap,Wildlife,Shopping,Kids,Sport`
4. Click **Create Web Service** and wait a few minutes for the first deploy to finish.

(Alternatively choose **New → Blueprint** and pick the repository. Render reads `render.yaml` and fills in the settings, and asks you for the password.)

**3. Run the show**
- Your address is shown at the top of the Render page, like `https://channel-changer-xxxx.onrender.com`.
- On the computer connected to the projector, open that address followed by **/screen**, e.g. `https://channel-changer-xxxx.onrender.com/screen`. Sign in with your host password.
- The QR code on screen now points to your online address. Phones scan it on Wi-Fi or mobile data.
- Everything else works as before: keys 1–7, F, C, Q and P, the rules, test voters, and the knob hub (in Chrome or Edge).
- **Sign out** is in the top bar. Signing in once keeps that browser signed in for 30 days.

**Things to know about Render's free plan**
- **It sleeps.** After 15 minutes with no visitors the server goes to sleep, and the first visit wakes it up in about a minute. **Open /screen 5–10 minutes before doors.** While the screen page is open it keeps the server awake.
- **It can restart at any time**, and a restart forgets the current channel, votes and any settings changed on screen. Phones reconnect by themselves; people turn their dial again. Put your channel names in `CHANNEL_NAMES` so they survive restarts.
- Free plans include 750 hours a month, which is plenty for shows and rehearsals.
- For shows where a hiccup would really hurt, Render's paid "Starter" instance doesn't sleep. You can switch the instance type in the service settings.

**Updating:** change a file on GitHub (or upload a new version) and Render redeploys automatically.

## How the voting works

- Each phone has one dial. Its position is that phone's vote, and it stays counted until the person turns it again or leaves.
- A channel takes over when **more than 50%** of everyone voting points at it for **3 seconds**.
- After a change, the channel is **locked for 60 seconds** so the actors get a scene in.
- After every change, old votes count as "stay". People turn or tap their dial again to vote again. This stops a stale crowd from flipping the channel by accident.
- Phones that joined but haven't turned their dial count as happy with what's on.
- A phone that closes the page or loses Wi-Fi stops counting after 2 minutes.

You can change all of these in the **Rules** panel while the show runs. Settings and channel names are saved in `settings.json`.

## Host controls (on the laptop)

| Key | Does |
|---|---|
| 1–7 | Cut straight to that channel (overrides the vote) |
| F | Freeze or unfreeze voting |
| C | End the cooldown now |
| Q | Show or hide the QR code on screen |
| P | Projector view on or off |

Host controls only work on the laptop itself. Audience phones can't reach them, even if someone guesses the address.

## Rehearsing without an audience

In **Rehearsal: test voters**, add 10 or 25 fake voters. Then use **Swing** to push them toward a channel, **Restless crowd** to have them drift on their own, or **Scatter** to split them. Your own phones can join alongside them. Click **Clear test voters** before doors open.

## Knob boxes (optional)

The physical knob hub from the earlier build still works. Plug it into the laptop by USB, click **Connect knob hub** on the screen page and pick its port. Knobs and phones vote together in the same count.

## Troubleshooting

- **"Port 3000 is already in use"**: another copy is running. Close it, or start with a different port: `PORT=3001 node server.js` (on Windows PowerShell: `$env:PORT=3001; node server.js`).
- **Phones can't open the link**: check they're on the same Wi-Fi, check the firewall allowed Node, and try the other address in the join panel.
- **The screen says it lost contact with the server**: the terminal running `node server.js` was closed. Start it again; phones reconnect by themselves.
- **One person, several votes**: each phone browser counts once. Someone could open extra private tabs to vote twice. For a 30-seat room this is rarely worth worrying about, but the room panel shows every remote if you want to keep an eye on it.
