"""Blender headless GLB -> FBX converter, for apps that take FBX but not glTF.

Usage (no shell, args after "--"):
  blender -b --factory-startup -P scripts/glb_to_fbx.py -- <in.glb> <out.fbx>

Exports into a temp dir next to the target and renames, so a crashed export
never leaves a partial .fbx. Textures are embedded; vertex colours are kept.
"""

import os
import sys
import tempfile

import bpy  # type: ignore[import-not-found]


def name_textures() -> None:
    """Give images a file extension: apps that unpack FBX textures to disk,
    such as TouchDesigner, can't load a file named just "Image_0"."""
    extensions = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp"}
    for image in bpy.data.images:
        extension = extensions.get(image.file_format)
        if extension and not image.name.lower().endswith(extension):
            image.name += extension
            image.filepath_raw = "//" + image.name


def main() -> int:
    argv = sys.argv
    args = argv[argv.index("--") + 1 :] if "--" in argv else []
    if len(args) != 2:
        print("glb_to_fbx: expected <in.glb> <out.fbx>", file=sys.stderr)
        return 2
    src, dst = (os.path.abspath(a) for a in args)
    if not os.path.isfile(src):
        print(f"glb_to_fbx: input not found: {src}", file=sys.stderr)
        return 2
    if not dst.lower().endswith(".fbx"):
        print("glb_to_fbx: output must end in .fbx", file=sys.stderr)
        return 2

    bpy.ops.wm.read_factory_settings(use_empty=True)
    result = bpy.ops.import_scene.gltf(filepath=src)
    if "FINISHED" not in result:
        print(f"glb_to_fbx: import failed: {result}", file=sys.stderr)
        return 1
    if not any(obj.type == "MESH" for obj in bpy.context.scene.objects):
        print("glb_to_fbx: no meshes in input", file=sys.stderr)
        return 1

    name_textures()

    with tempfile.TemporaryDirectory(dir=os.path.dirname(dst), prefix=".fbx-") as tmpdir:
        tmp = os.path.join(tmpdir, os.path.basename(dst))
        result = bpy.ops.export_scene.fbx(
            filepath=tmp,
            path_mode="COPY",
            embed_textures=True,
            colors_type="SRGB",
            add_leaf_bones=False,
            # Real sizes: unit scale in the file header, no 100x on the objects,
            # so an app that ignores FBX units still gets the GLB's own scale.
            apply_scale_options="FBX_SCALE_ALL",
            axis_forward="-Z",
            axis_up="Y",
        )
        if "FINISHED" not in result or not os.path.isfile(tmp):
            print(f"glb_to_fbx: export failed: {result}", file=sys.stderr)
            return 1
        os.replace(tmp, dst)
    print(f"glb_to_fbx: wrote {dst}")
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception as exc:  # operator TypeErrors would otherwise exit 0
        print(f"glb_to_fbx: {exc!r}", file=sys.stderr)
        code = 1
    sys.stdout.flush()
    sys.stderr.flush()
    # sys.exit inside -P only raises; os._exit makes the exit code reach the caller.
    os._exit(code)
