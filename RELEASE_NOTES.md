## JellyTunes 0.7.1: HTTP is your call again, and the sync counters tell the truth

Three changes over 0.7.0. If 0.7.0 refused to talk to your server, this one asks first and then does as you say.

### What's new

**Plain HTTP asks instead of refusing.** 0.7.0 flatly blocked login to a server reached over `http://`, and for anyone running Jellyfin on a home LAN with no TLS in front of it, that was the end of the road. The release notes told you to stay on 0.6.0. Now JellyTunes explains the risk and lets you decide: before a single credential leaves the app you get a dialog saying the connection is not encrypted and that anyone on the same wifi can read what you send, with a checkbox you have to tick before Continue does anything. Accept once and that server stops asking, on this launch and every one after it, including automatic reconnects. A different address asks again, and `localhost` never asks at all. The reasoning behind the 0.7.0 block hasn't changed, an API key sent in the clear is still an admin-capable credential that never expires, but the choice is yours now.

**The sync counters were lying.** If you selected an artist and its album artist, or an album and a playlist that share tracks, JellyTunes counted those tracks once per thing you selected. Ten tracks on the server could show as 23 already on the device before a sync, and "Copied: 32 tracks" after one. The files on your device were always correct, because a track already there is detected and skipped. Only the counting was wrong, in two separate places, and both now count each track once.

**Linux: no more half-dark window.** In the snap build the titlebar followed your system theme but the menu bar below it did not, so a dark desktop got a dark title with a light menu glued underneath, and the build from CI didn't even match the one from the Snap Store. The menu bar is now hidden on Linux, the way it has been on Windows all along. Copy, cut and paste keep working as before.

---

### Installing

Full, current instructions for every platform live in the [installation guide](https://github.com/orainlabs/jellytunes#installation). Two things there are worth reading before you download:

- **macOS.** JellyTunes isn't signed with an Apple Developer certificate. On Apple silicon macOS reports that as the app being _damaged_, which it is not. The guide names both dialogs, says which chip produces which, and gives the one-line fix.
- **Linux.** Install from the Snap Store rather than from the assets below. The `.snap` is deliberately not attached here, because a file downloaded from GitHub carries no store signature and `snap install` rejects it. The `.deb` is in the assets, and so is the AppImage (legacy), which still runs but is deprecated. The [migration guide](https://github.com/orainlabs/jellytunes/blob/main/docs/INSTALLATION.md) walks you through moving to Snap or `.deb`.

Want the full technical breakdown? See the [CHANGELOG.md](https://github.com/orainlabs/jellytunes/blob/main/CHANGELOG.md).
