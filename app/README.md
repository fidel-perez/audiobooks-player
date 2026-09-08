# Audiobooks Player

A browser-only audiobook reader for Standard Ebooks and Project Gutenberg
titles in English and Spanish. It fetches each EPUB straight from those
sites, reads it aloud with an on-device Piper voice or the OS voice, and
tracks your place per book: no book text ships in this repo, and no server
is required.

## Run it

```
python3 -m http.server 8000
```

then open `http://localhost:8000/` from the `app/` directory. Everything
runs client-side: progress, your queue, and your settings live in
IndexedDB in that browser.

## Sync across devices (optional)

Settings → 🔗 Sincronización takes a URL for your own key-value sync server
(one implementing `GET`/`PUT` on `<url>/kv/<key>`). Leave it blank and the
player stays IndexedDB-only, one device, no server involved.

## Voices

Piper voices run on-device via WebAssembly and download from Hugging Face
on first use, 60-80 MB each, cached after. `es_ES-sharvard-medium` is CC BY
3.0 (Blizzard 2013 Lessac corpus, University of Edinburgh): keep this notice
if you redistribute a build that bundles it. Every other voice listed in
`js/config.js` is MIT, CC0, or public-domain LibriVox source audio.

## License

MIT, see `LICENSE`. Contact: hello@automate-it-all.win
