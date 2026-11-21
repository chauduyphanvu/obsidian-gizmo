"""Drives Obsidian on an iPhone or iPad connected by USB, through Web Inspector, for checks the
desktop live suite can't make (touch layouts, iOS WebKit).

  uvx --from pymobiledevice3 python test/live/phone.py eval '<js body>'
  uvx --from pymobiledevice3 python test/live/phone.py evalfile <file.js>
  uvx --from pymobiledevice3 python test/live/phone.py shot <out.png>

The JS runs as the body of an async function in Obsidian's page (it may await), and what it
returns comes back as JSON. Obsidian must be open on the device, with the device unlocked and
Settings → Apps → Safari → Advanced → Web Inspector on. Test in a vault of its own, not one with
your notes: what a check clicks writes into the vault that is open. To open one:
  xcrun devicectl device process launch --device <id> --payload-url 'obsidian://open?vault=<name>' md.obsidian
"""
import asyncio
import base64
import json
import sys

from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.webinspector import WebinspectorService

BUNDLE = "md.obsidian"


async def call(s, method, params):
    """Sends one inspector command to the page and returns its reply, unwrapped from the target message."""
    r = await s.send_and_receive({"method": method, "params": params})
    if r.get("method") == "Target.dispatchMessageFromTarget":
        r = json.loads(r["params"]["message"])
    return r


async def main() -> int:
    cmd, arg = sys.argv[1], sys.argv[2]
    lockdown = await create_using_usbmux()
    inspector = WebinspectorService(lockdown=lockdown)
    await inspector.connect()
    try:
        async with inspector:
            pages = [p for p in await inspector.get_open_application_pages(timeout=3) if p.application.bundle == BUNDLE]
            if not pages:
                print("no Obsidian page (is the app open and the phone unlocked?)", file=sys.stderr)
                return 2
            s = await inspector.inspector_session(pages[0].application, pages[0].page)
            await s.runtime_enable()
            if cmd in ("eval", "evalfile"):
                body = open(arg).read() if cmd == "evalfile" else arg
                # WebKit's evaluate gives the promise itself; Runtime.awaitPromise waits for it.
                p = await call(s, "Runtime.evaluate", {
                    "expression": f"(async () => {{ {body}\n}})().then((v) => JSON.stringify(v === undefined ? null : v))"})
                if p.get("result", {}).get("wasThrown") or "error" in p:
                    print(json.dumps(p)[:2000], file=sys.stderr)
                    return 1
                r = await call(s, "Runtime.awaitPromise", {"promiseObjectId": p["result"]["result"]["objectId"], "returnByValue": True})
                res = r.get("result", {})
                if res.get("wasThrown") or "error" in r:
                    print(json.dumps(r)[:2000], file=sys.stderr)
                    return 1
                value = res.get("result", {}).get("value")
                print(value if isinstance(value, str) else json.dumps(value))
                return 0
            if cmd == "shot":
                size = await call(s, "Runtime.evaluate", {"expression": "JSON.stringify([innerWidth, innerHeight])", "returnByValue": True})
                w, h = json.loads(size["result"]["result"]["value"])
                r = await call(s, "Page.snapshotRect", {"x": 0, "y": 0, "width": w, "height": h, "coordinateSystem": "Viewport"})
                url = r.get("result", {}).get("dataURL")
                if not url:
                    print(json.dumps(r)[:1000], file=sys.stderr)
                    return 1
                with open(arg, "wb") as f:
                    f.write(base64.b64decode(url.split(",", 1)[1]))
                print(arg)
                return 0
            print(f"unknown command {cmd}", file=sys.stderr)
            return 2
    finally:
        await inspector.close()


sys.exit(asyncio.run(main()))
