# Using Adrift 3D results in three.js

**Export for Three.js** appears next to Export for Blender on a mesh or splat result. It downloads a zip you can open
as it is or copy into a project:

- `index.html`, a page that shows the files with orbit controls and one button per file.
- The model files. GLB and splats are copied as they are; OBJ and mesh PLY are converted to GLB.
- `README.txt`, with code to load a mesh and a splat in your own scene.

To view it, unzip and start any local web server, because browsers block these loads from `file://`:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## What it depends on

Adrift itself stays local and adds no package for this. The exported page loads pinned versions from the jsDelivr CDN
when it opens, so it needs internet then: [three.js](https://threejs.org) (MIT) and, only for splats,
[Spark](https://sparkjs.dev) (MIT). In your own project, install those packages and change the import map.

## Splats

three.js has no Gaussian splat support of its own, so the page uses Spark's `SplatMesh`. Splat files are Y-down, so a
splat needs this to line up with the GLB from the same job:

```js
splat.quaternion.set(1, 0, 0, 0);
```

## What's left out

USD and BVH aren't included, and a `.gltf` comes without any `.bin` or textures it references. The README in the zip
lists anything left out. GLB is the best choice from Make 3D.

## HTTP

```text
GET /api/comfy/threejs-bundle?filename=<name>&subfolder=<folder>&type=output
```

Repeat the three parameters for up to 8 files. [TOUCHDESIGNER.md](TOUCHDESIGNER.md) lists the other HTTP routes.
