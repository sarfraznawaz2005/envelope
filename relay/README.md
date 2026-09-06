# Envelope relay

A very small program. It lets the browser app talk to your mail servers.

Browsers cannot open mail connections (IMAP, POP3, SMTP). This relay accepts a
WebSocket from the app, opens the real connection, and copies bytes both ways.
It does not read your mail. It has no mail logic.

## Run

```bash
cd relay
npm install
node index.js
```

You will see:

```
envelope-relay v0.1.0 listening on ws://127.0.0.1:8765
```

You will also see a generated token printed to the console the first time
you run it (unless you set your own `--token`). Copy it into the app.

Then in the app: Settings → Relay → `ws://127.0.0.1:8765` and paste the token.

## Run without installing Node.js (Windows .exe)

If you don't want to install Node.js just to run the relay, build it into one
file:

```bash
cd relay
npm install
npm run build:exe
```

This makes `relay/dist/envelope-relay.exe` — a real copy of Node with the
relay code baked in. Copy that one file anywhere and double-click it, or run
it from a terminal with the same options as above (`--port`, `--token`, ...).
No install step needed on the machine that runs it.

The first time you run it, Windows SmartScreen may warn that it's from an
unknown publisher (it isn't code-signed). Click "More info" → "Run anyway".
This is expected for a locally-built .exe — it isn't a virus, just unsigned.

macOS/Linux: the same command builds a plain `envelope-relay` binary
instead (no `.exe`).

## Options

```
--port <n>            Listen port (default 8765)
--host <addr>         Listen address (default 127.0.0.1)
--token <secret>      Require this token on every connection
--allow-host <h>      Only allow these target hosts (repeatable)
--allow-port <n>      Extra target ports (repeatable)
--allow-origin <url>  Only accept browsers from these origins (repeatable)
--max-conns <n>       Max open sockets (default 64)
--config <file>       JSON file with the same keys (see relay.config.example.json)
--verbose             Log every connection
```

The token can also come from the `RELAY_TOKEN` environment variable.

## Safety notes

- Certificate checks are always on. There is no switch to turn them off.
- By default it listens on `127.0.0.1` only — but that only stops *other
  computers*. Any web page open in the same browser can still open a
  WebSocket to `127.0.0.1:8765` and use it as a proxy into your network,
  because browsers don't apply same-origin rules to outbound WebSockets.
  That's why a token is required by default (generated automatically if you
  don't set one) — a page can't guess it, so it can't connect. Only run with
  `--no-token` if you understand and accept that risk.
- If you run it on a server: set `--token`, and put it behind an HTTPS reverse
  proxy so the browser uses `wss://`. Do not expose plain `ws://` on the internet.
- The relay sees plaintext after TLS. So run it on a machine you trust.

## Protocol (for developers)

Connect: `ws://host:port/?host=<mail-host>&port=<n>&tls=<0|1>&token=<t>`

- Binary frames = raw bytes.
- Text frames = JSON control:
  - relay → `{"ok":"connected","tls":true|false}` after the target is open
  - client → `{"cmd":"starttls"}` to upgrade a plain socket (after the
    protocol's STARTTLS handshake)
  - relay → `{"ok":"starttls"}` when done
  - relay → `{"error":"..."}` then the socket closes

Health check: `GET http://127.0.0.1:8765/health`
