## JellyTunes 0.7.0 — Log in with your Jellyfin password, and Jellyfin 12 works again

Two things people asked for in the same release. You no longer need to create an API key to use JellyTunes, and the app talks to Jellyfin 12 again.

### What's new

**Log in with your username and password.** Creating an API key was the first thing JellyTunes asked of you, and for most people it was the only reason they ever opened their Jellyfin dashboard. Now the login screen starts with username and password, the way you'd expect. Your session is stored encrypted and reconnects on launch, and JellyTunes remembers which mode you used. If you prefer an API key, it's one click away under _Use an API key instead (advanced)_. Requested in [#9](https://github.com/orainlabs/jellytunes/issues/9).

**Jellyfin 12 works again.** Upgrading a server to 12.0 broke JellyTunes 0.6.0: the library stopped resolving, and reconnecting failed with "Could not identify user. Please select manually." Jellyfin 12 rejects the legacy `X-Emby-Token` header that JellyTunes had been sending since the beginning. Every request now uses the `MediaBrowser` authorization scheme, which works across Jellyfin 10.10 through 12. Reported in [#13](https://github.com/orainlabs/jellytunes/issues/13).

**Logging in now requires HTTPS.** If you reach your server over plain `http://` on a LAN address, JellyTunes will refuse to log in and tell you so. An API key sent in the clear is an admin-capable credential that never expires, and a password is worse. `localhost`, `127.0.0.1` and `::1` are exempt, because that traffic never leaves the machine. Sessions you already saved keep working, so this only bites when you log in again. If you're on `http://` and can't put TLS in front of Jellyfin, stay on 0.6.0 for now and open an issue so we know how many of you there are.

### Also fixed

- A library tab that fails to load now shows an error with a Retry button instead of an endless loading skeleton, and Retry actually refetches
- Login failures that can't reach the server say so, instead of showing `Failed to fetch`
- Cancelling a sync stops mid-download instead of finishing the tracks already in flight, and no longer leaves temporary files behind in the destination
- Genre browsing is scoped to the logged-in user
- The Album Artists tab shows its own name in the header instead of `albumArtists`

---

### Installing

Full, current instructions for every platform live in the [installation guide](https://github.com/orainlabs/jellytunes#installation). Two things there are worth reading before you download:

- **macOS.** JellyTunes isn't signed with an Apple Developer certificate. On Apple silicon macOS reports that as the app being _damaged_, which it is not. The guide names both dialogs, says which chip produces which, and gives the one-line fix.
- **Linux.** Install from the Snap Store rather than from the assets below. The `.snap` is deliberately not attached here, because a file downloaded from GitHub carries no store signature and `snap install` rejects it. The `.deb` is in the assets, and so is the AppImage (legacy), which still runs but is deprecated. The [migration guide](https://github.com/orainlabs/jellytunes/blob/main/docs/INSTALLATION.md) walks you through moving to Snap or `.deb`.

Want the full technical breakdown? See the [CHANGELOG.md](https://github.com/orainlabs/jellytunes/blob/main/CHANGELOG.md).
