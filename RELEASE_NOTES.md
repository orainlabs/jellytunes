## JellyTunes 0.5.0 — Your whole library, organized your way

Your music collection is more than a flat list of artists, and now JellyTunes treats it that way. This release brings real Album Artist and Genre browsing, consistent playback volume with ReplayGain, and a cleaner, more focused window. Behind the scenes, we spent a lot of time making sync just work, even on the messiest libraries.

### What's new

**Browse by Album Artist.** You shouldn't have to scroll past a hundred "Various Artists" entries to find the album you're after. The new Album Artists tab gives you a clean view of your collection, with its own selection and sync that stays completely separate from individual track artists.

**Find music by genre.** Sometimes you don't want an artist, you want a mood. The new Genres tab lets you browse, filter, and sync a whole genre at once, with genre artwork right there in the list and a live count of what you've got. Flip a genre on and it syncs from then on.

**The right volume on every track.** No more reaching for the volume knob between songs. JellyTunes now pulls ReplayGain tags straight from Jellyfin and embeds them, so quiet tracks and loud tracks land at a level that just feels right.

### Reliability you can count on

This is where most of the work went. We wanted sync to be something you never have to think about, especially on big libraries:

- Album and track details now sync correctly every time when you sync by artist
- Tracks that show up on more than one album sync once instead of over and over, so you're not waiting on duplicate transfers
- Storage tracking got a lot sharper. Disk usage refreshes right after a sync, and the storage bar actually reflects what's on your device
- Large libraries load smoothly now, even against servers that get loose with pagination, so no more endless spinners
- Steadier file handling means your tracks end up exactly where they should

---

Want the full technical breakdown? See the [CHANGELOG.md](CHANGELOG.md).
