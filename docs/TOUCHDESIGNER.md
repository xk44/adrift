# Using Adrift results in TouchDesigner

Adrift has no live TouchDesigner link. It writes standard files that TouchDesigner can read, and it has an HTTP API
that TouchDesigner can call with a small Python client. Each section says what was run. Tests used TouchDesigner 2025.32460 under Wine on
Linux, not on Windows or macOS; please open an issue if a step doesn't work.

Unity, Unreal and Blender notes are in [GAME_ENGINES.md](GAME_ENGINES.md).

## Gaussian splats

Run **3D splat** (one image of an object or character) and download the `.ply` or `.spz`. TripoSplat's `.ply` has the
standard 3DGS attributes (`x y z`, `f_dc_0-2`, `opacity`, `scale_0-2`, `rot_0-3`).

Recent TouchDesigner builds ship palette components for this:
[gsLoader](https://derivative.ca/UserGuide/Palette:gsLoader) reads `.ply` and `.spz` into a POP,
[gsGeo](https://derivative.ca/UserGuide/Palette:gsGeo) sorts the splats for a Render TOP (uniform scale only), and
[gsScene](https://derivative.ca/UserGuide/Palette:gsScene) combines several. They weren't in the 2025.32460 install we tested,
so they are untested.

Without them, a Point File In POP read all 262,144 points of a TripoSplat `.ply` with positions and normals. To keep the
splat values, add them on its attribute parameters, for example a float attribute with the field `f_dc_0`. Those are raw
3DGS values, not RGB, and the POP warns that it found no `r g b a` colour. We didn't get a picture from this route, so
treat it as a way to read the data, not as a splat renderer.

## Meshes (FBX)

**Export FBX** appears next to Export for Blender on any result with a GLB: Make 3D, MoGe, body and hair, and 3D splat
with **Mesh** on. Load the file with an FBX COMP. It needs Blender on the computer running Adrift (`BLENDER_PATH`, or
Settings → Blender). Sizes are the model's own, Y up.

- **Splats don't become FBX.** FBX has no way to store Gaussians, so the FBX of a splat run is its mesh, which is a
  different look from the splat.
- **TripoSplat meshes are coloured per vertex**, with no texture. The material the FBX COMP builds shows the colours; a
  material of your own has to use vertex colour, or the mesh renders plain.
- A textured TRELLIS mesh and a vertex-coloured TripoSplat mesh both imported through an FBX COMP and rendered correctly
  in a Render TOP. The base colour and normal textures loaded. TouchDesigner warns that the normal map needs tangents,
  which a Normal POP can add. Rigged meshes haven't been tried in TouchDesigner.

## Video, images and audio

Results are ordinary files: MP4 and PNG load with a Movie File In TOP, and WAV with an Audio File In CHOP.

## Driving Adrift from TouchDesigner

[`scripts/adrift_td.py`](../scripts/adrift_td.py) runs Adrift tools that take one image, one video or text from Python,
with nothing to install in TouchDesigner. Tools needing a second image, audio or a mask aren't supported yet. It reads
size and length from MP4 and MOV clips; other formats are sent as 1280x720 with the tool's default length. If ComfyUI
restarts mid-job, the job never reports done, so call `job.cancel()`. It uses only the standard library, so it also runs from a terminal. Paste it into a Text DAT named
`adrift_td`, then:

```python
client = mod.adrift_td.Client("http://127.0.0.1:3000")
job = client.start("action:image_to_splat", project.folder + "/adrift", image="shot.png")
```

`start()` works on a thread so TouchDesigner keeps cooking. Check it from an Execute DAT's `onFrameStart`, and only touch
operators from there:

```python
if job.done:
    print(job.error or job.files)
```

`client.tools()` lists tool ids and their options, and `job.cancel()` stops a run. Set `api_key=` or `ADMIN_API_KEY` when a key is set.
Inside TouchDesigner it loaded from a Text DAT and `client.tools()` worked against a test server. A full `start()` run
has only been tested from Python against the HTTP API, not inside TouchDesigner.

### The calls it makes

1. `GET /api/tools/agent` lists tools.
2. `POST /api/tools/agent/compile`, `POST /api/jobs/seed-run` and `POST /api/jobs/action` start a run.
   `POST /api/jobs/tool` starts a `catalog:` tool.
3. `GET /api/comfy/history/<prompt_id>` returns the outputs when it is done, and 404 until then.
4. `GET /api/comfy/image?filename=…&subfolder=…&type=output` downloads one.
   `GET /api/comfy/fbx?filename=<name>.glb&subfolder=…&type=output` downloads a GLB as FBX.
   `GET /api/comfy/progress?client_id=…` streams progress as server-sent events.

The same calls back the MCP server ([MCP.md](MCP.md)). Send `Authorization: Bearer <ADMIN_API_KEY>` when a key is set.

## Compared with TouchDesigner packs for ComfyUI

These packs ship `.tox` components, and most add ComfyUI nodes. Adrift doesn't bundle or depend on any of them, and you
can use them with the same ComfyUI. This comes from their READMEs; none of them were run.

| | Adrift + `adrift_td.py` | [ComfyUI-TD](https://github.com/JiSenHua/ComfyUI-TD) | [TDComfyUI](https://github.com/olegchomp/TDComfyUI) | [TouchDesigner-ComfyUI-Engine](https://github.com/ZhaoYuanxin66/TouchDesigner-ComfyUI-Engine) |
| --- | --- | --- | --- | --- |
| Nodes or `.tox` to install | None | Both | `.tox`, plus tooling nodes | Both |
| Start, cancel and read results | Yes | Yes | Yes | Yes |
| Uses a ready-made tool | Yes, by tool id | You build the workflow | You supply the workflow | You build the workflow |
| Live frames into TOPs | **No**, files after the run | Yes | Yes | Yes, with denoise previews |
| 3DGS PLY or points into TouchDesigner | PLY file, read with a splat renderer | Streamed | No | No |
| Licence | Adrift's | AGPL-3.0 | None stated | MIT |

For live frames while a job runs, use one of those packs. Adrift's route is better for finished results.

Splat renderers that read a standard 3DGS PLY should read Adrift's, since it has the standard attributes:
the palette `gsLoader` above and community projects such as
[TD-Gaussian-Splatting](https://github.com/yeataro/TD-Gaussian-Splatting). None of them have been tested with it.
