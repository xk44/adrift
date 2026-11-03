"""Blender headless GLB -> USDZ converter.

Usage (no shell, args after "--"):
  blender -b --factory-startup -P scripts/glb_to_usdz.py -- <in.glb> <out.usdz>

Runs on any platform Blender runs on (win/mac/linux). Exports into a temp
dir next to the target and renames, so a crashed export never leaves a
partial .usdz that clients would treat as finished.
"""

import os
import sys
import tempfile

import bpy  # type: ignore[import-not-found]

VERTEX_COLOR_PROP = "cj_vertex_color_layer"
# USD primvar names of the colour layers _wire_vertex_colors rewired.
_REWIRED_PRIMVARS: set = set()


class CJVertexColorHook(bpy.types.USDHook):
    """Author a UsdPrimvarReader for vertex-colour materials.

    Blender's USD exporter writes the colour attribute as a primvar but drops
    the Color Attribute node, leaving diffuseColor a constant grey. This hook
    copies the colours into the standard `displayColor` primvar (SceneKit /
    Model I/O read only that one, and it is color3f, matching the reader)
    and connects diffuseColor to a UsdPrimvarReader of it.

    The material is bound with the `preview` purpose, not allPurpose:
    RealityKit (AR Quick Look) renders the allPurpose primvar-reader binding
    near-black and iOS Model I/O drops the colours under it, while both
    render the preview binding coloured. Renderers that ask for the `full`
    purpose see no material and fall back to displayColor, which USD defines
    as the unbound-mesh colour, so every renderer still gets the colours.
    """

    bl_idname = "cj_vertex_color_hook"
    bl_label = "CJ vertex colour primvar reader"

    @staticmethod
    def on_material_export(export_context, bl_material, usd_material):
        layer = bl_material.get(VERTEX_COLOR_PROP)
        if not layer:
            return False
        from pxr import Sdf, Tf, UsdShade  # bundled with Blender

        stage = export_context.get_stage()
        material = UsdShade.Material(usd_material)
        source = material.ComputeSurfaceSource()
        surface = source[0] if source else None
        if not surface:
            return False
        reader = UsdShade.Shader.Define(
            stage, usd_material.GetPath().AppendChild("vertex_color_reader")
        )
        reader.CreateIdAttr("UsdPrimvarReader_float3")
        reader.CreateInput("varname", Sdf.ValueTypeNames.String).Set("displayColor")
        _REWIRED_PRIMVARS.add(Tf.MakeValidIdentifier(layer))
        reader.CreateInput("fallback", Sdf.ValueTypeNames.Float3).Set((0.8, 0.8, 0.8))
        out = reader.CreateOutput("result", Sdf.ValueTypeNames.Float3)
        surface.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).ConnectToSource(out)
        return True

    @staticmethod
    def on_export(export_context):
        """Copy each rewired colour layer (often color4f) into displayColor."""
        if not _REWIRED_PRIMVARS:
            return False
        from pxr import Gf, UsdGeom, Vt  # bundled with Blender

        stage = export_context.get_stage()
        copied = 0
        for prim in stage.Traverse():
            if not prim.IsA(UsdGeom.Mesh):
                continue
            api = UsdGeom.PrimvarsAPI(prim)
            for name in _REWIRED_PRIMVARS:
                src = api.GetPrimvar(name)
                values = src.Get() if src and src.HasAuthoredValue() else None
                if not values:
                    continue
                rgb = Vt.Vec3fArray([Gf.Vec3f(v[0], v[1], v[2]) for v in values])
                dst = UsdGeom.Gprim(prim).CreateDisplayColorPrimvar(src.GetInterpolation())
                dst.Set(rgb)
                if src.IsIndexed():
                    dst.SetIndices(src.GetIndices())
                _rebind_as_preview(prim)
                copied += 1
                break
        if copied:
            print(f"glb_to_usdz: displayColor on {copied} mesh(es)")
        return copied > 0


def _rebind_as_preview(prim) -> None:
    """Move a mesh's allPurpose material binding to the preview purpose."""
    from pxr import UsdShade  # bundled with Blender

    binding = UsdShade.MaterialBindingAPI(prim)
    material = binding.GetDirectBinding().GetMaterial()
    if not material:
        return
    # Remove rather than UnbindDirectBinding(): an empty allPurpose binding
    # reads as "explicitly unbound" to some resolvers.
    prim.RemoveProperty(binding.GetDirectBindingRel().GetName())
    binding.Bind(material, materialPurpose=UsdShade.Tokens.preview)


def _wire_vertex_colors() -> int:
    """Rebuild materials of vertex-coloured meshes as Principled BSDF fed by a
    Color Attribute node.

    TripoSR/Hunyuan GLBs (ComfyUI save_glb) carry colour in COLOR_0 with a
    KHR_materials_unlit material. Blender imports that as an emission mix the
    USD exporter can't translate, so the USDZ comes out with an empty material
    and QuickLook/RealityKit render it untextured. A Principled BSDF with its
    Base Color from the attribute exports as UsdPreviewSurface +
    UsdPrimvarReader, which every USD viewer understands.
    """
    rewired = 0
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        mesh = obj.data
        attrs = getattr(mesh, "color_attributes", None)
        if not attrs or len(attrs) == 0:
            continue
        attr_name = (attrs.active_color or attrs[0]).name
        # Skip materials that already sample an image texture: those export fine.
        slots = [s.material for s in obj.material_slots if s.material]
        if any(
            m.node_tree and any(n.type == "TEX_IMAGE" for n in m.node_tree.nodes)
            for m in slots
        ):
            continue
        mat = bpy.data.materials.new(name=f"{obj.name}_vertex_color")
        if bpy.app.version < (5, 0, 0):  # node trees are always on from 5.0
            mat.use_nodes = True
        nodes = mat.node_tree.nodes
        bsdf = nodes.get("Principled BSDF")
        col = nodes.new("ShaderNodeVertexColor")
        col.layer_name = attr_name
        mat.node_tree.links.new(col.outputs["Color"], bsdf.inputs["Base Color"])
        bsdf.inputs["Roughness"].default_value = 1.0
        bsdf.inputs["Metallic"].default_value = 0.0
        mat[VERTEX_COLOR_PROP] = attr_name
        mesh.materials.clear()
        mesh.materials.append(mat)
        rewired += 1
    return rewired


def main() -> int:
    argv = sys.argv
    if "--" not in argv:
        print("glb_to_usdz: missing '--' args", file=sys.stderr)
        return 2
    args = argv[argv.index("--") + 1 :]
    if len(args) != 2:
        print("glb_to_usdz: expected <in.glb> <out.usdz>", file=sys.stderr)
        return 2
    src, dst = (os.path.abspath(a) for a in args)
    if not os.path.isfile(src):
        print(f"glb_to_usdz: input not found: {src}", file=sys.stderr)
        return 2
    if not dst.lower().endswith(".usdz"):
        print("glb_to_usdz: output must end in .usdz", file=sys.stderr)
        return 2

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.utils.register_class(CJVertexColorHook)
    result = bpy.ops.import_scene.gltf(filepath=src)
    if "FINISHED" not in result:
        print(f"glb_to_usdz: import failed: {result}", file=sys.stderr)
        return 1
    if not any(obj.type == "MESH" for obj in bpy.context.scene.objects):
        print("glb_to_usdz: no meshes in input", file=sys.stderr)
        return 1

    rewired = _wire_vertex_colors()
    if rewired:
        print(f"glb_to_usdz: wired vertex colours on {rewired} mesh(es)")

    # Export into a private temp dir under the final name (the packaged layer
    # inside the zip is named after it), then atomically move it into place.
    with tempfile.TemporaryDirectory(dir=os.path.dirname(dst), prefix=".usdz-") as tmpdir:
        tmp = os.path.join(tmpdir, os.path.basename(dst))
        code = _export(tmp)
        if code:
            return code
        os.replace(tmp, dst)
    print(f"glb_to_usdz: wrote {dst}")
    return 0


def _export(tmp: str) -> int:
    result = bpy.ops.wm.usd_export(
        filepath=tmp,
        selected_objects_only=False,
        export_materials=True,
        generate_preview_surface=True,  # UsdPreviewSurface: what QuickLook/RealityKit render
        export_textures_mode="NEW",
        convert_orientation=True,  # Blender is Z-up; AR QuickLook expects Y-up
        export_global_forward_selection="NEGATIVE_Z",
        export_global_up_selection="Y",
    )
    if "FINISHED" not in result or not os.path.isfile(tmp):
        print(f"glb_to_usdz: export failed: {result}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception as exc:  # operator TypeErrors would otherwise exit 0
        print(f"glb_to_usdz: {exc!r}", file=sys.stderr)
        code = 1
    sys.stdout.flush()
    sys.stderr.flush()
    # sys.exit inside -P only raises; os._exit makes the exit code reach the caller.
    os._exit(code)
