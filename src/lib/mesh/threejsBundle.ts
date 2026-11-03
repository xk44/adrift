/**
 * "Export for Three.js": a zip with a job's 3D files and a page that shows them.
 * Meshes load with three.js's own loaders; Gaussian splats load with Spark, the
 * MIT splat renderer for three.js. OBJ and mesh PLY become GLB. Adrift itself
 * ships neither library for this: the page takes pinned copies from a CDN.
 */

import {
  blenderRoute,
  safeStem,
  type BundleFile,
  type BundleInput,
} from "./blenderBundle";
import { parseObj, parsePlyMesh, writeGlb } from "./meshConvert";

export const THREE_VERSION = "0.180.0";
export const SPARK_VERSION = "2.4.0";

export type ThreejsAssetKind = "gltf" | "stl" | "fbx" | "points" | "splat";

export interface ThreejsAsset {
  path: string;
  kind: ThreejsAssetKind;
}

export interface ThreejsBundle {
  name: string;
  files: BundleFile[];
  assets: ThreejsAsset[];
  notes: string[];
}

function ext(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

/** Build the bundle. A file three.js can't take is left out and noted. */
export function buildThreejsBundle(inputs: readonly BundleInput[]): ThreejsBundle {
  const name = safeStem(inputs[0]?.name ?? "model");
  const files: BundleFile[] = [];
  const assets: ThreejsAsset[] = [];
  const notes = new Set<string>();
  const used = new Set(["index.html", "README.txt"]);
  const add = (stem: string, e: string, data: Uint8Array, kind: ThreejsAssetKind) => {
    let path = `${stem}.${e}`;
    for (let i = 2; used.has(path); i++) path = `${stem}_${i}.${e}`;
    used.add(path);
    files.push({ path, data });
    assets.push({ path, kind });
  };

  for (const input of inputs) {
    const stem = safeStem(input.name);
    const e = ext(input.name);
    const route = blenderRoute(input.name, input.data.subarray(0, 64 * 1024));
    if (route.action === "splat" || route.action === "splatOnly") {
      add(stem, e, input.data, "splat");
    } else if (route.action === "toGlb") {
      try {
        const mesh =
          route.from === "obj"
            ? parseObj(new TextDecoder().decode(input.data))
            : parsePlyMesh(input.data);
        add(stem, "glb", writeGlb(mesh, stem), "gltf");
        notes.add(
          "OBJ and PLY meshes were converted to GLB with geometry, UVs and vertex colours, without separate material or texture files.",
        );
      } catch {
        notes.add(`${input.name} could not be converted to GLB, so it was left out.`);
      }
    } else if (route.action === "copy") {
      if (route.kind === "gltf") {
        add(stem, e, input.data, "gltf");
        if (e === "gltf")
          notes.add(
            "A .gltf file can reference separate .bin and texture files. Only the .gltf itself is included.",
          );
      } else if (route.kind === "stl" || route.kind === "fbx") {
        add(stem, e, input.data, route.kind);
      } else if (route.kind === "points") {
        add(stem, e, input.data, "points");
      } else {
        notes.add(`${input.name} was left out: this page doesn't load that format.`);
      }
    }
  }

  files.unshift(
    { path: "index.html", data: threejsPage(name, assets) },
    { path: "README.txt", data: threejsReadme(name, assets, [...notes]) },
  );
  return { name, files, assets, notes: [...notes] };
}

/** JSON safe inside a <script> element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function threejsPage(name: string, assets: readonly ThreejsAsset[]): string {
  const hasSplat = assets.some((a) => a.kind === "splat");
  const imports: Record<string, string> = {
    three: `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.module.js`,
    "three/addons/": `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/`,
  };
  if (hasSplat)
    imports["@sparkjsdev/spark"] =
      `https://cdn.jsdelivr.net/npm/@sparkjsdev/spark@${SPARK_VERSION}/dist/spark.module.js`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>
  html, body { margin: 0; height: 100%; background: #16171a; color: #e8e8ea; font: 14px system-ui, sans-serif; overflow: hidden; }
  canvas { display: block; }
  #bar { position: fixed; top: 12px; left: 12px; display: flex; flex-wrap: wrap; gap: 6px; max-width: calc(100vw - 24px); }
  #bar button { font: inherit; color: inherit; background: #2a2c31; border: 1px solid #44474e; border-radius: 6px; padding: 6px 10px; cursor: pointer; }
  #bar button[aria-pressed="true"] { background: #e8e8ea; color: #16171a; }
  #msg { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; pointer-events: none; }
</style>
<script type="importmap">${scriptJson({ imports })}</script>
</head>
<body>
<div id="bar"></div>
<div id="msg" role="status">Loading…</div>
<script type="module">
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const ASSETS = ${scriptJson(assets)};
const msg = document.getElementById("msg");
const bar = document.getElementById("bar");

if (location.protocol === "file:") {
  msg.textContent = "Browsers block model files on a page opened from disk. In this folder, run: python3 -m http.server 8000 and open http://localhost:8000";
  throw new Error("served from file://");
}

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x16171a);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment()).texture;
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const mixers = [];

async function loadAsset(asset) {
  if (asset.kind === "splat") {
    const { SparkRenderer, SplatMesh } = await import("@sparkjsdev/spark");
    if (!scene.userData.spark) {
      scene.userData.spark = new SparkRenderer({ renderer });
      scene.add(scene.userData.spark);
    }
    const splat = new SplatMesh({ url: asset.path });
    await splat.initialized;
    // Splat files are Y-down: turn 180 degrees about X to stand upright with the GLB.
    splat.quaternion.set(1, 0, 0, 0);
    splat.updateMatrixWorld(true);
    scene.add(splat);
    return { object: splat, box: splat.getBoundingBox().applyMatrix4(splat.matrixWorld) };
  }
  let object;
  if (asset.kind === "gltf") {
    const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
    const gltf = await new GLTFLoader().loadAsync(asset.path);
    object = gltf.scene;
    if (gltf.animations.length) {
      const mixer = new THREE.AnimationMixer(object);
      mixer.clipAction(gltf.animations[0]).play();
      mixers.push(mixer);
    }
  } else if (asset.kind === "fbx") {
    const { FBXLoader } = await import("three/addons/loaders/FBXLoader.js");
    object = await new FBXLoader().loadAsync(asset.path);
  } else {
    const { PLYLoader } = await import("three/addons/loaders/PLYLoader.js");
    const { STLLoader } = await import("three/addons/loaders/STLLoader.js");
    if (asset.kind === "points") {
      const geometry = await new PLYLoader().loadAsync(asset.path);
      object = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 0.005, vertexColors: geometry.hasAttribute("color") }));
    } else {
      const geometry = await new STLLoader().loadAsync(asset.path);
      geometry.computeVertexNormals();
      object = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xc9c9cd }));
    }
  }
  scene.add(object);
  return { object, box: new THREE.Box3().setFromObject(object) };
}

function frame(box) {
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(0, radius * 0.35, radius * 2.6));
  camera.near = radius / 100;
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
}

try {
  const loaded = [];
  for (const asset of ASSETS) loaded.push({ asset, ...(await loadAsset(asset)) });
  if (!loaded.length) throw new Error("This bundle has nothing three.js can show.");
  const show = (chosen) => {
    for (const item of loaded) {
      item.object.visible = item === chosen;
      item.button?.setAttribute("aria-pressed", String(item === chosen));
    }
    frame(chosen.box);
  };
  if (loaded.length > 1) {
    for (const item of loaded) {
      item.button = document.createElement("button");
      item.button.textContent = item.asset.path;
      item.button.onclick = () => show(item);
      bar.appendChild(item.button);
    }
  }
  show(loaded[0]);
  msg.remove();
} catch (err) {
  msg.textContent = "Couldn't load the model: " + (err && err.message ? err.message : err);
  console.error(err);
}

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  for (const mixer of mixers) mixer.update(dt);
  controls.update();
  renderer.render(scene, camera);
});
</script>
</body>
</html>
`;
}

export function threejsReadme(
  name: string,
  assets: readonly ThreejsAsset[],
  notes: readonly string[],
): string {
  const splat = assets.find((a) => a.kind === "splat");
  const mesh = assets.find((a) => a.kind === "gltf");
  const lines = [
    `${name}: Three.js export from Adrift`,
    "",
    "See it: browsers won't load model files from a page opened from disk, so serve this folder:",
    "",
    "  python3 -m http.server 8000",
    "",
    "then open http://localhost:8000. The page needs internet once, for three.js"
      + (splat ? " and Spark" : "")
      + " from a CDN.",
    "",
  ];
  if (mesh || splat) lines.push("Use it in your own three.js project:", "");
  if (mesh)
    lines.push(
      `  import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";`,
      `  scene.add((await new GLTFLoader().loadAsync("${mesh.path}")).scene);`,
      "",
    );
  if (splat)
    lines.push(
      `  // npm install @sparkjsdev/spark (Gaussian splats, three ${THREE_VERSION} or newer)`,
      `  import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";`,
      `  scene.add(new SparkRenderer({ renderer }));`,
      `  const splat = new SplatMesh({ url: "${splat.path}" });`,
      `  splat.quaternion.set(1, 0, 0, 0); // splat files are Y-down`,
      `  scene.add(splat);`,
      "",
    );
  if (notes.length) lines.push("Notes:", ...notes.map((n) => `- ${n}`), "");
  return lines.join("\n");
}
