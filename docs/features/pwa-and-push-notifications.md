# Install the app & base-attack alerts

EQX Peri can be **installed to your home screen** like a native app, and can send
you a **notification when your base is attacked while you're away**.

## Installing

- **Android (Chrome/Edge):** open the menu and choose “Install app” / “Add to Home
  Screen”, or accept the install prompt when it appears.
- **Desktop (Chrome/Edge):** click the install icon in the address bar.
- **iPhone/iPad (Safari):** tap the **Share** button, then **Add to Home Screen**.
  Open the game from the new home-screen icon.

Installed, the game runs full-screen in its own window (no browser bar) and updates
itself automatically — a new version downloads in the background and is applied the
next time you launch, so you're never interrupted mid-fight.

## Enabling base-attack alerts

In **Settings → Notifications**, turn on **“Base-attack alerts”** and allow
notifications when your browser asks. You'll then get a push notification —
**“Base under attack”** — when one of your structures is attacked while you're not
connected. (You won't be pestered while you're actively playing, and alerts are
rate-limited to at most one per base every 15 minutes.)

### iPhone / iPad

Apple only allows notifications for web apps that have been **added to the home
screen**. If you open Settings in Safari before installing, you'll see a hint to
“Add to Home Screen” first — do that, open the game from the home-screen icon, and
the alerts toggle will be available.

## Turning alerts off

Flip the same toggle off (it unsubscribes this device), or revoke notification
permission in your browser/OS settings.

---

For how this works under the hood (PWA manifest, service worker, VAPID/web-push,
the offline-gated trigger), see
[docs/architecture/web-push.md](../architecture/web-push.md).
