# Remote client

Use dotpals from your phone, tablet or foldable: the same dashboard (every page, every setting), live, installable as an app, with notifications you choose. **Off until you turn it on.**

Settings → Remote on the computer. Nothing here runs, listens or sends anything until then.

## Set it up

1. **Turn it on.** Settings → Remote → *Remote client*. It listens on port 5176 (change it there).
2. **Give it https.** Phones only install apps, keep a sign-in cookie and receive notifications over https. Pick one:
   - **A tunnel (easiest).** Keep *Reachable from* on "This computer only" and point a tunnel at `http://127.0.0.1:5176`:
     `cloudflared tunnel --url http://127.0.0.1:5176` (or Tailscale: `tailscale serve --bg --https=443 http://127.0.0.1:5176`). Paste the https address it prints into *Address your devices open*.
   - **https on your own network, no tunnel.** Run `dotpals remote cert` (or Settings → Remote → *https on my network*). It makes a small private certificate authority and a certificate for this computer's LAN addresses **and its `.local` name**, points the remote client at it and prints the steps for your phone. Do the phone step once: copy `~/.dotpals/remote-cert/ca.pem` to it and install it as a CA certificate (Android: Settings → Security → Encryption & credentials → Install a certificate; iPhone/iPad: open the file, install the profile, then turn it on under Settings → General → About → Certificate Trust Settings). Compare the fingerprint it shows. After that, `https://<this computer's address>:5176/pair` works, and the QR code opens it.
     - **It looks after itself.** When the computer's address changes (a new router lease, Wi-Fi to Ethernet), dotpals issues a new certificate within a minute and swaps it in without dropping anything. The CA stays the same, so phones need nothing. A moment with no network keeps the current certificate. If a renewal fails, Settings → Remote says so and the old certificate keeps serving.
     - **Address or name?** The certificate covers both, and the QR code carries the address (it works on every phone, the instant you scan it). The name (`nighthawk.local`) survives an address change, which is why it's also accepted and shown under the QR code, but it only works where the device can look up `.local` names (multicast DNS). Apple devices do that; on Android it depends on the version and browser, and routers with "client isolation" block it. That's untested here beyond this Windows computer answering mDNS correctly, so try it on your phone before relying on it. Your router doesn't know the name (this setup checked), so nothing depends on it. For a name that always works, give the computer a fixed address in your router (a DHCP reservation) and use that.
     - The CA is restricted by X.509 name constraints to private addresses and `.local` names. Even if its key leaked, it couldn't vouch for a real website, and installing it on your phone doesn't make one look trusted.
     - Needs `openssl`; Git for Windows includes one. Windows' firewall may need to allow the app in on your network (private networks are usually already open).
   - **Your own certificate.** Set `remote.tlsCert` and `remote.tlsKey` (file paths) in `~/.dotpals/config.json`, choose "Anything on my network", and use `https://<this computer>:5176`.
3. **Pair.** *Pair a device* shows a QR code and a code like `7K2M-9QXD-4TBH`. Scan it with the phone's camera, or open `<your address>/pair` and type it. The code works once and expires in 5 minutes.
4. **Install.** The app offers *Install* in its own Settings → Remote (Chrome, Edge, Samsung Internet), or use the browser's menu. On iPhone/iPad: Share → Add to Home Screen.
5. **Notifications.** On the device: Settings → Remote → *Notify this device*, then pick what you want to hear about.

## What a paired device can do

Out of the box a device can **look** (everything the dashboard shows) and change how things **look and sound** (pal, sounds, notification settings, story view). It can not run anything on your computer.

Turn on **Let this device control** (on the computer, per device) and it can also answer agents' permission prompts, hand off sessions, rewind a request, start Blu's tasks and change any setting except the remote settings themselves. Allowing an agent's `npm install` *is* running it, so this is separate and off by default: a lost phone can only look.

Never from a device, whatever its switch: agents' hooks and events, quitting the app, pairing others, the remote settings.

## Notifications

Chosen per device, on the device: a request finishes (only ones that took a while), an agent is waiting for you (still waiting after 20 s), an agent asks permission (needs *control*), an agent seems stuck, two agents on one file, an agent gave up on failing tests, a context window nearly full (off by default). *Only when I'm away* skips them while the app is open on that device.

They're [Web Push](https://www.rfc-editor.org/rfc/rfc8030): the computer encrypts each one for that device ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)) and signs it ([VAPID, RFC 8292](https://www.rfc-editor.org/rfc/rfc8292)), and your browser's push service (Google, Mozilla, Apple) carries it. It sees an encrypted blob, a timestamp and your computer's address, never the text. The text is shortened and has secrets removed before it's encrypted. At most one per thing per 10 s and 20 a minute per device.

## Real time, cheaply

- The live stream is open **only while the app is in front of you.** Hidden for 15 seconds, it closes: no connection, no radio, no work on the computer. Coming back it asks for just what it missed (`?since=`), not the whole history.
- Changes to the same thing are sent once (a tool call that updates ten times in a moment is one message), in one write, gzip-compressed.
- Scripts and styles are cached by the service worker and revalidated with ETags, so opening the app is instant and mostly sends nothing.
- A device that can't keep up is dropped and resumes, not buffered. With no device connected, no timers run.
- A new device loads the last 3 days (`remote.historyDays`, 1 to 7).

## Foldables

The layout follows the [Device Posture API](https://developer.mozilla.org/en-US/docs/Web/API/Device_Posture_API) and the [Viewport Segments API](https://developer.mozilla.org/en-US/docs/Web/API/Viewport_Segments_API), read before the first paint:

| Situation | Layout |
| --- | --- |
| Flat, phone | Bottom navigation, 44 px+ touch targets, safe areas |
| Flat, tablet or unfolded | List and detail side by side from 640 px |
| Two screens side by side, or half-open in landscape (*book*) | A rail, then one pane on each screen; nothing crosses the hinge |
| Half-open, hinge across the middle (*tabletop*) | Content on the upper half, navigation on the lower |
| Installed on a desktop | Window Controls Overlay: the title bar is yours |

Where the browser gives real segment geometry, the hinge's width and each screen's size come from it; with only a `folded` posture, each half is half the screen and a safe gap stays clear. To try it on any browser: `localStorage.setItem('dotpals.posture', 'folded')` (and `dotpals.span` = `horizontal` or `vertical`), then reload.

Not yet tried on a physical foldable: the layouts are checked in Edge with the posture forced, which exercises the same CSS and attributes the real APIs set.

## Security

- The remote listener is a **second** server. The bridge's own `127.0.0.1:5175` (agents' hooks, approvals, quitting) is unchanged and never reachable from a network.
- A pairing code is 60 random bits, hashed in memory, single use, 5 minutes, and rides in the URL `#fragment` (never sent to a server or logged; the page removes it from the address bar). Too many wrong tries cancels pending codes.
- Pairing only completes over https (or from this computer). The device cookie is `HttpOnly; Secure; SameSite=Strict`, 256 random bits; only its SHA-256 is stored, in `~/.dotpals/remote.json` (0600).
- Every request is checked: host name, origin, a custom header on changes, the device, then what that device may do. Pages carry a Content Security Policy that allows only this origin's scripts.
- Sign a device out from the computer or the device; it's cut off at once, mid-stream.
- Don't expose port 5176 to the internet without https. A tunnel is fine; port-forwarding plain http is not.

## Files

`bridge/remote-server.js` (listener, pairing, routing) · `remote.js` (devices, permissions) · `remote-hub.js` (live stream) · `remote-push.js` (what notifies) · `webpush.js` (encryption, VAPID) · `remote-assets.js` (static files) · `bridge/remote/` (the app: `boot.js`, `stream.js`, `client.js`, `settings.js`, `sw.js`, `pair.*`, `remote.css`, manifest, icons) · `bridge/vendor/qrcode.js` (MIT).
