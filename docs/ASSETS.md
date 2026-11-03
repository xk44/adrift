# Optional Asset Layouts

Adrift can use a local moodboard library when you point environment variables at directories on disk. These assets are user-obtained and are not distributed with this repository.

## Krea Moodboards

Set:

```env
KREA_MOODBOARDS_DIR=/path/to/krea-moodboards
```

Expected image layout:

```text
krea-moodboards/
  <board>_images/
    image-1.png
    image-2.jpg
    image-3.webp
  _<index>.json
```

Image files may use `.png`, `.jpg`, `.jpeg`, or `.webp`. `_*.json` files are local indexes produced outside the app and may sit alongside the board image folders.
