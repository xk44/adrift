#!/usr/bin/env python3
"""Run Adrift tools from TouchDesigner, or any Python 3.8+. Standard library only.

No custom nodes, no .tox and nothing to install: this talks to a running Adrift
over HTTP (docs/TOUCHDESIGNER.md). Put the file in a Text DAT named adrift_td,
or on your Python path.

    import adrift_td                          # in a Text DAT: mod.adrift_td
    client = adrift_td.Client("http://127.0.0.1:3000")
    job = client.start("action:image_to_splat", image="shot.png",
                       options={"mesh": "on"}, out_dir=project.folder + "/adrift")

start() returns at once and works on a thread, so TouchDesigner keeps cooking.
Check job.done from an Execute DAT's onFrameStart; job.files then lists the
downloaded paths and job.error says what went wrong. Only touch operators from
that callback, never from the thread. job.cancel() stops a run.

From a terminal:
    python3 adrift_td.py tools
    python3 adrift_td.py run action:image_to_splat --image shot.png --option mesh=on --out out
"""

import argparse
import base64
import json
import mimetypes
import os
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


class AdriftError(Exception):
    pass


def image_size(data):
    """(width, height) of a PNG or JPEG, or None."""
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        return struct.unpack(">II", data[16:24])
    if data[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h, w = struct.unpack(">HH", data[i + 5:i + 9])
                return w, h
            i += 2 + struct.unpack(">H", data[i + 2:i + 4])[0]
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP" and len(data) >= 30:
        chunk = data[12:16]
        if chunk == b"VP8X":
            return (int.from_bytes(data[24:27], "little") + 1, int.from_bytes(data[27:30], "little") + 1)
        if chunk == b"VP8L":
            bits = int.from_bytes(data[21:25], "little")
            return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
        if chunk == b"VP8 ":
            w, h = struct.unpack("<HH", data[26:30])
            return w & 0x3FFF, h & 0x3FFF
    return None


def mp4_info(data):
    """(width, height, seconds) from an MP4 or MOV header; each is None if not found."""
    info = {"size": None, "seconds": None}

    def walk(start, end, depth):
        i = start
        while i + 8 <= end and depth < 6:
            size = struct.unpack(">I", data[i : i + 4])[0]
            kind = data[i + 4 : i + 8]
            header = 8
            if size == 1 and i + 16 <= end:
                size = struct.unpack(">Q", data[i + 8 : i + 16])[0]
                header = 16
            elif size == 0:
                size = end - i
            if size < header or i + size > end:
                return
            body = i + header
            if kind in (b"moov", b"trak", b"mdia"):
                walk(body, i + size, depth + 1)
            elif kind == b"mvhd" and info["seconds"] is None:
                if data[body] == 1:
                    scale, length = struct.unpack(">IQ", data[body + 20 : body + 32])
                else:
                    scale, length = struct.unpack(">II", data[body + 12 : body + 20])
                if scale > 0:
                    info["seconds"] = round(length / scale, 3)
            elif kind == b"tkhd" and info["size"] is None:  # audio tracks have size 0
                w, h = struct.unpack(">II", data[i + size - 8 : i + size])
                if w and h:
                    info["size"] = (round(w / 65536), round(h / 65536))
            i += size

    try:
        walk(0, len(data), 0)
    except (struct.error, IndexError):
        pass  # truncated or not MP4: keep what was read
    width, height = info["size"] or (None, None)
    return width, height, info["seconds"]


class Client:
    def __init__(self, base_url=None, api_key=None, timeout=120):
        self.base_url = (base_url or os.environ.get("ADRIFT_URL") or "http://127.0.0.1:3000").rstrip("/")
        self.api_key = api_key if api_key is not None else os.environ.get("ADMIN_API_KEY", "")
        self.timeout = timeout
        self.client_id = "adrift-td-" + uuid.uuid4().hex[:12]

    def _request(self, path, body=None):
        headers = {"Origin": self.base_url, "X-Requested-With": "XMLHttpRequest"}
        if self.api_key:
            headers["Authorization"] = "Bearer " + self.api_key
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base_url + path, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                return res.read()
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace")
            try:
                detail = json.loads(detail).get("error", detail)
            except ValueError:
                pass
            raise AdriftError("%s: HTTP %d: %s" % (path.split("?")[0], err.code, detail)) from err
        except urllib.error.URLError as err:
            raise AdriftError("Can't reach Adrift at %s: %s" % (self.base_url, err.reason)) from err

    def get(self, path):
        return json.loads(self._request(path))

    def post(self, path, body):
        return json.loads(self._request(path, body))

    def tools(self):
        """Every tool: id, name, category, source (image, video or none), inputSchema."""
        return self.get("/api/tools/agent")["tools"]

    def upload(self, path):
        """Upload a local file; returns its Adrift ref and bytes."""
        with open(path, "rb") as f:
            data = f.read()
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        url = "data:%s;base64,%s" % (mime, base64.b64encode(data).decode())
        res = self.post("/api/comfy/upload", {"image": url, "filename": os.path.basename(path)})
        return res["ref"], data

    def submit(self, tool_id, image=None, video=None, text=None, options=None):
        """Start a tool; returns its ComfyUI prompt ids."""
        tool = next((t for t in self.tools() if t["id"] == tool_id), None)
        if tool is None:
            raise AdriftError('Unknown tool "%s"' % tool_id)
        if tool.get("available") is False:
            raise AdriftError("%s isn't available: %s" % (tool["name"], tool.get("unavailableReason", "")))
        if tool.get("kind") == "catalog":
            images = [self.upload(image)[0]] if image else []
            body = {"toolId": tool_id.replace("catalog:", "", 1), "images": images, "client_id": self.client_id}
            if text:
                body["prompt"] = text
            if options:
                body["options"] = options
            return self._job_ids(self.post("/api/jobs/tool", body))

        compiled = self.post(
            "/api/tools/agent/compile", {"toolId": tool_id, "text": text, "options": options or {}}
        )
        source = tool.get("source")
        if source == "none":
            params = compiled.get("params") or {}
            prompt = params.get("prompt") or params.get("script") or tool["name"]
            seeded = self.post("/api/jobs/seed-run", {"text_only": True, "prompt": prompt})
        else:
            path = video if source == "video" else image
            if not path:
                raise AdriftError("%s needs an input %s" % (tool["name"], source))
            ref, data = self.upload(path)
            seed = {"ref": ref, "prompt": tool["name"]}
            if source == "video":
                width, height, seconds = mp4_info(data)
                if seconds:
                    seed["duration"] = seconds
                seed["width"], seed["height"] = width or 1280, height or 720
            else:
                seed["width"], seed["height"] = image_size(data) or (1024, 1024)
            seeded = self.post("/api/jobs/seed-run", seed)
        run = seeded.get("run") or {}
        if not run.get("run_id"):
            raise AdriftError("Couldn't prepare the source run")
        body = {
            "run_id": run["run_id"],
            "job_index": (run.get("jobs") or [{}])[0].get("index", 0),
            "action": compiled["action"],
            "client_id": self.client_id,
            "tool_page_id": compiled.get("tool_page_id"),
            "params": compiled.get("params") or {},
        }
        if compiled.get("overrides"):
            body["workflow_control_overrides"] = compiled["overrides"]
        return self._job_ids(self.post("/api/jobs/action", body))

    @staticmethod
    def _job_ids(data):
        ids = [j["prompt_id"] for j in (data.get("run") or {}).get("jobs", []) if j.get("prompt_id")]
        if not ids:
            raise AdriftError("Adrift returned no job")
        return ids

    def outputs(self, prompt_id):
        """The job's history, or None while it hasn't finished."""
        try:
            return self.get("/api/comfy/history/" + urllib.parse.quote(prompt_id, safe=""))
        except AdriftError as err:
            if "HTTP 404" in str(err):
                return None
            raise

    def download(self, output, out_dir):
        """Save one output; returns the local path."""
        query = urllib.parse.urlencode(
            {
                "filename": output["filename"],
                "subfolder": output.get("subfolder", ""),
                "type": output.get("type", "output"),
            }
        )
        data = self._request("/api/comfy/image?" + query)
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, os.path.basename(output["filename"]))
        temp = path + ".part"
        with open(temp, "wb") as f:
            f.write(data)
        os.replace(temp, path)
        return path

    def cancel(self, prompt_id):
        return self.post("/api/jobs/cancel", {"prompt_id": prompt_id})

    def run(self, tool_id, out_dir, image=None, video=None, text=None, options=None, poll=2.0, job=None):
        """Run a tool to the end and download every output; returns the paths."""
        ids = self.submit(tool_id, image=image, video=video, text=text, options=options)
        if job is not None:
            job.prompt_ids = ids
            if job.cancelled:  # cancelled while uploading: the ids didn't exist yet
                job.cancel()
        paths = []
        for prompt_id in ids:
            history = None
            while history is None:  # 404 until the job has finished
                if job is not None and job.cancelled:
                    raise AdriftError("Cancelled")
                time.sleep(poll)
                history = self.outputs(prompt_id)
            error = _history_error(history)
            if error:
                raise AdriftError(error)
            for kind in ("images", "videos", "audios", "meshes"):
                for output in history.get(kind) or []:
                    if output.get("filename") and output.get("type", "output") == "output":
                        paths.append(self.download(output, out_dir))
        return paths

    def start(self, tool_id, out_dir, image=None, video=None, text=None, options=None, poll=2.0):
        """Like run(), on a thread. Returns a Job at once."""
        job = Job(self)

        def work():
            try:
                job.files = self.run(
                    tool_id, out_dir, image=image, video=video, text=text, options=options, poll=poll, job=job
                )
            except Exception as err:  # reported through job.error, on TouchDesigner's own frame
                job.error = str(err)
            finally:
                job.done = True

        threading.Thread(target=work, daemon=True).start()
        return job


def _history_error(history):
    status = history.get("status") or {}
    for message in status.get("messages") or []:
        if isinstance(message, list) and message and message[0] == "execution_error":
            return message[1].get("exception_message", "Execution error")
    return "The job failed" if status.get("status_str") == "error" else None


class Job:
    """A run in progress: done, files, error, prompt_ids, cancel()."""

    def __init__(self, client):
        self._client = client
        self.done = False
        self.cancelled = False
        self.files = []
        self.error = None
        self.prompt_ids = []

    def cancel(self):
        self.cancelled = True
        for prompt_id in self.prompt_ids:
            self._client.cancel(prompt_id)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run Adrift tools over HTTP.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("tools", help="List tool ids")
    run = sub.add_parser("run", help="Run a tool and download its outputs")
    run.add_argument("tool_id")
    run.add_argument("--image")
    run.add_argument("--video")
    run.add_argument("--text")
    run.add_argument("--option", action="append", default=[], metavar="KEY=VALUE")
    run.add_argument("--out", default="adrift_out")
    args = parser.parse_args(argv)
    client = Client()
    try:
        if args.command == "tools":
            for tool in client.tools():
                print("%s\t%s" % (tool["id"], tool["name"]))
        else:
            options = dict(o.split("=", 1) for o in args.option)
            paths = client.run(args.tool_id, args.out, args.image, args.video, args.text, options)
            print("\n".join(paths))
    except AdriftError as err:
        parser.exit(1, "adrift_td: %s\n" % err)


if __name__ == "__main__":
    main()
