# Using Adrift meshes in Blender, Unity and Unreal

Adrift has no plugin inside Unity or Unreal, no viewport projection and no live link to any of the three. It writes
standard files that these apps import, and it has an HTTP API you can call from Python. Each section says what was run.

Tests used Blender 5.1.2 on Linux. **Unity and Unreal were not available: the steps for them follow their usual import
settings and have not been run.** Please open an issue if a step doesn't work.

## Meshes

Results with a GLB (Make 3D, MoGe, body and hair, 3D splat with **Mesh** on) have these next to the download links:

- **Export for Blender**: a zip with the model, an import script and a readme. In Blender, open the script in the
  Scripting tab and press Run Script.
- **Export FBX**: one `.fbx` with embedded textures, written Y up and -Z forward. It needs Blender on the computer running
  Adrift (`BLENDER_PATH`, or found on the usual paths).

Unity (not run): copy the `.fbx` into `Assets`. To edit its material, select it and use **Materials > Extract Textures**.

Unreal (not run): in the Content Browser use **Import**, choose the `.fbx`, and keep **Import Textures** and
**Import Materials** on.

## Driving Adrift from Python

[`scripts/adrift_td.py`](../scripts/adrift_td.py) uses only the standard library, so it can drive Adrift from Blender's
Python. Put it on `sys.path`, then:

```python
import adrift_td
client = adrift_td.Client("http://127.0.0.1:3000")
paths = client.run("action:material_maps", "/path/to/out", image="/path/to/shot.png")
```

We ran `tools()` and a text-only `run()` inside `blender -b --python-expr` (Blender 5.1.2, Python 3.14) against a stub HTTP
server, not a real Adrift. It listed tools, started a job, read the history and downloaded the output. Uploads and
`start()` were not run in Blender. `run()` blocks Blender until the job ends. With `start()`, touch `bpy` only from the main
thread. See [TOUCHDESIGNER.md](TOUCHDESIGNER.md) for the routes.

**Unreal's Python is untested.**

## Plugins and MCP servers that connect these apps

Adrift doesn't bundle or depend on any of these, and **none of them were run with Adrift**. The descriptions come from their READMEs. Check each licence yourself.

- [ComfyUI-Blender](https://github.com/alexisrolland/ComfyUI-Blender) (GPL-3.0): a Blender add-on and nodes that use ComfyUI from inside Blender.
- [Comfyui-Texturaizer](https://github.com/LatentSpaceDirective/Comfyui-Texturaizer) (GPL-3.0): nodes that connect ComfyUI to the Texturaizer Blender plugin.
- [ComfyTextures](https://github.com/AlexanderDzhoganov/ComfyTextures) (MIT): an Unreal plugin that textures scenes through ComfyUI.
- [ComfyUI-TextureAlchemy](https://github.com/amtarr/ComfyUI-TextureAlchemy): ComfyUI nodes for PBR and texture processing.
- [Unity MCP](https://github.com/CoplayDev/unity-mcp) (MIT): lets an AI assistant manage assets in the Unity Editor.
- [Unreal MCP](https://github.com/chongdashu/unreal-mcp) (no licence listed): lets an AI assistant control Unreal Engine.

The first four can point at the same ComfyUI that Adrift uses. An assistant with Adrift's MCP server and one of the editor MCP servers could in principle run a tool and bring in its result. We haven't tried that.
