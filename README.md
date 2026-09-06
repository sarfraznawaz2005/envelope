# Envelope

A browser-only email client. IMAP, POP3, and SMTP. No app server — your mail,
contacts, and settings live in a local SQLite database inside your browser
(via OPFS). A tiny relay program moves raw bytes between your browser and
your mail servers, because browsers cannot open direct mail connections.

Installable as a PWA (desktop app-like window, works offline for the app
shell). Master-password protected, with encrypted account credentials and
an optional auto-save copy to a folder on disk.

## How it's put together

```
app/     the client — Vue 3 + TypeScript, everything mail-related runs here
relay/   the relay — a small Node program, WebSocket <-> TCP/TLS bridge only
```

The relay never reads or stores your mail. It only copies bytes between a
WebSocket (from the browser) and a real TCP/TLS socket (to your mail
server). All parsing, storage, encryption, and the mail UI live entirely in
`app/`, in your browser.

## Prerequisites

- [Node.js](https://nodejs.org/) 20 or newer
- [pnpm](https://pnpm.io/) (`corepack enable` on modern Node, or
  `npm install -g pnpm`) — used for the `app/` half only; the relay uses
  plain `npm`
- Chrome or Edge (or another Chromium browser). The local database needs
  OPFS, which Firefox/Safari don't fully support yet — those browsers can
  still use the app, but rely on manual download/upload backup instead of
  the automatic local database

## Installation

**1. Clone this repository**

```bash
git clone <this repo's URL>
cd MailClient
```

**2. Install and start the relay**

```bash
cd relay
npm install
node index.js
```

You'll see `envelope-relay v0.1.0 listening on ws://127.0.0.1:8765`, plus a
generated token printed to the console — copy it, you'll paste it into the
app in a moment. (Don't want Node.js installed permanently? `npm run
build:exe` packages the relay into one `.exe`/binary you can just
double-click instead — see `relay/README.md`.)

Leave this running and open a second terminal for the next step.

**3. Install and build the app**

```bash
cd app
pnpm install
pnpm build
```

This produces `app/dist` — a folder of plain static files.

**4. Serve the app**

```bash
pnpm preview
```

Open the URL it prints (usually `http://localhost:4173`).

(For active development instead of a one-off production run, use `pnpm dev`
in this folder instead of `build` + `preview` — it gives you hot reload.)

## First-time setup, in the app

1. You'll be asked to set a **master password**. This encrypts your account
   passwords in the local database. Choose "remember on this device" for
   7 days, always, or never — your call.
2. Add an account (Settings → Accounts → Add, or the setup wizard on first
   run). You'll need your email, and your mail provider's IMAP/POP3 + SMTP
   host, port, and password (or an app password, for providers like Gmail
   that require one).
3. Under Settings → Relay, confirm the relay URL (default `ws://127.0.0.1:8765`
   matches the relay's default) and paste in the token the relay printed
   in step 2 above.
4. Mail starts syncing automatically. New mail arrives live (IMAP IDLE) —
   no manual refresh needed.

## Installing as an app (PWA)

Once the app is open in Chrome or Edge, click the install icon in the
header (or the browser's own install/add-to-home-screen prompt). It opens
in its own window from then on, like a native app. Your data doesn't move —
it's the same browser storage either way, so closing and reopening (as a
tab or as the installed app) keeps everything.

The app shell (the UI itself) also works offline once it's been opened at
least once — useful if your connection drops while you're reading already-synced
mail. Sending, receiving new mail, and the relay connection still need a
real network connection, obviously.

## Your data, backups, and starting over

- **Local-only by default.** Nothing leaves your browser except the mail
  protocol traffic to your own mail servers (through the relay).
- **Disk auto-save** (Settings → Storage & Backup): pick a folder, and the
  app periodically writes a copy of its database there — a safety net if
  browser storage is ever cleared.
- **Backup / restore**: export one `.json` file (accounts, settings,
  contacts, rules, signatures — passwords stay encrypted with your master
  password) with an option to include the full mail cache. Import restores
  from it, asking for the backup's master password if it's different from
  your current one.
- **Empty data** (Settings → Empty data): clear cached mail, attachments,
  contacts, or everything, per account or per folder. This only clears the
  local cache — it never touches mail on your actual mail server.

## Running the relay somewhere other than your own PC

By default the relay only listens on `127.0.0.1` (this machine only) and
requires a token, so it's safe out of the box. If you ever run it on a
server so other devices can reach it, read `relay/README.md`'s "Safety
notes" section first — you'll need `--token` and a `wss://` (HTTPS) reverse
proxy in front of it.

## Development

```bash
cd app
pnpm dev         # dev server with hot reload
pnpm typecheck   # vue-tsc, no emit
pnpm test        # vitest
pnpm build       # production build
```

See `relay/README.md` for the relay's own options (`--token`, `--allow-host`,
`--allow-origin`, building a standalone binary, etc).
