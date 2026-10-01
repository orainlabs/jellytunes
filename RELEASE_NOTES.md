## JellyTunes 0.7.2: failed tracks tell you why, and Windows 11 24H2 works properly

Mostly fixes. If a sync failed on you with nothing but an FFmpeg exit code, or JellyTunes stopped making sense of your drives after a recent Windows 11 update, this release is for you.

### What's new

**A bad download now says what went wrong** ([#23](https://github.com/orainlabs/jellytunes/issues/23)). When a server answered with something that wasn't audio, a converted track failed with nothing but `FFmpeg exited with code 1`. Now the track fails with a message saying what the server sent back, and no junk lands on your device. Network errors are retried, and a stalled download no longer hangs the sync. Conversions that failed on Windows in 0.7.1 now work. If this still happens to you, Report a Bug now attaches your last sync, so the issue already holds what we need to look into it.

**Windows 11 24H2 and later.** Microsoft removed a tool JellyTunes relied on, so recent Windows 11 lost track of drives, free space and filesystem, and names containing `< > : " | ? *` made tracks fail. Drives, free space and filesystem show up again, those names are made safe for Windows, and you can pick a drive root such as `E:\` as your destination.

**"Sync failed" shows every error, with the real cause.** Every failed track gets its own row with the reason FFmpeg actually reported, for example `Invalid data found when processing input`, not just an exit code.

**Converted MP3s are smaller, so more of them fit.** Converting used to turn the cover into a PNG, so a 106 KB cover from Jellyfin took up about 880 KB inside every MP3. Covers now go in as a compact JPEG, which saves roughly three quarters of a megabyte per track in that case. Tracks already on your device aren't downloaded again just for this. They get the new cover the next time they're re-synced for some other reason, or when you change the cover mode.

**A wiped or swapped device gets synced again.** After you formatted, swapped or partly cleared a card, JellyTunes could mark the missing tracks as already synced. The sync then reported success in seconds and left the device empty. Now it checks that each file is really there, and the Sync Preview counts any missing tracks as work still to do.

**And a few smaller ones:**

- **Only one JellyTunes at a time:** launching it again brings the open window to the front instead of starting a second copy.
- **Windows shows the volume label** next to the drive letter in the device list.
- **Open log folder** in About takes you straight to `main.log` when a bug report asks for it.
- **macOS: subfolders on FAT32 and exFAT sticks** now get safe names, so characters like `:` and `?` no longer reach a filesystem that rejects them.
- **The size estimate adds up:** overlapping selections aren't counted twice, both storage bars agree, and album checkmarks show when their artist is selected.

---

### Installing

Full, current instructions for every platform live in the [installation guide](https://github.com/orainlabs/jellytunes#installation). Two things there are worth reading before you download:

- **macOS.** JellyTunes isn't signed with an Apple Developer certificate. On Apple silicon macOS reports that as the app being _damaged_, which it is not. The guide names both dialogs, says which chip produces which, and gives the one-line fix.
- **Linux.** Install from the Snap Store rather than from the assets below. The `.snap` is deliberately not attached here, because a file downloaded from GitHub carries no store signature and `snap install` rejects it. The `.deb` is in the assets, and so is the AppImage (legacy), which still runs but is deprecated. The [migration guide](https://github.com/orainlabs/jellytunes/blob/main/docs/INSTALLATION.md) walks you through moving to Snap or `.deb`.

Want the full technical breakdown? See the [CHANGELOG.md](https://github.com/orainlabs/jellytunes/blob/main/CHANGELOG.md).
