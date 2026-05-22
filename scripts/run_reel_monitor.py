"""Avvia CreateReel e monitora pipeline fino alle anteprime storyboard."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import httpx

DESCRIPTION = """Spot pubblicitario cinematografico ultra realistico per una lametta da barba premium.

Il reel deve trasmettere lusso, precisione, mascolinità moderna ed eleganza visiva, con lo stile di una pubblicità di profumo di fascia alta mescolata a un commercial automotive cinematografico. L'atmosfera deve essere sensuale, sofisticata e potente.

La scena si apre con macro estreme delle lame metalliche della lametta illuminate da luce cinematografica morbida e riflessi caldi. Gocce d'acqua scorrono lentamente sull'acciaio lucidato. Bagno di lusso con marmo nero, vapore leggero, uomo carismatico che si rade con precisione. Finale: lametta su marmo con gocce e luce drammatica."""

BASE = "http://127.0.0.1:8765"
DATA = Path.home() / ".cinematic-studio" / "projects"


def check_storyboard_files(storage_id: str) -> list[dict]:
    sb = DATA / storage_id / "storyboard"
    if not sb.is_dir():
        return []
    out = []
    for p in sorted(sb.glob("*.png")):
        out.append({"name": p.name, "bytes": p.stat().st_size, "ok": p.stat().st_size >= 3000})
    return out


def probe_api(storage_id: str, clip_id: str) -> int:
    url = f"{BASE}/api/reel/storyboard-clip/{storage_id}/{clip_id}"
    try:
        r = httpx.get(url, timeout=30.0)
        return r.status_code
    except Exception as e:
        return -1


def main() -> int:
    payload = {
        "project_id": "reel_standalone",
        "title": "Lametta Premium Monitor",
        "description": DESCRIPTION,
        "duration_sec": 30,
        "style": "instagram adv video, photorealistic, netflix style",
        "aspect_ratio": "9:16",
        "width": 1080,
        "height": 1920,
        "concurrent_jobs": 1,
        "clip_backend": "auto",
        "allow_ffmpeg_fallback": False,
        "storyboard_max_side": 320,
        "storyboard_steps": 10,
        "phase": "full",
    }

    print("POST /api/reel/generate …")
    storage_id = None
    job_id = None
    clips_ok: list[str] = []
    clips_fail: list[str] = []
    terminal = False

    with httpx.Client(timeout=None) as client:
        with client.stream("POST", f"{BASE}/api/reel/generate", json=payload) as resp:
            if resp.status_code != 200:
                print(f"HTTP {resp.status_code}: {resp.text[:500]}")
                return 1
            buf = ""
            for chunk in resp.iter_text():
                buf += chunk
                while "\n\n" in buf or "\n" in buf:
                    if "\n\n" in buf:
                        block, buf = buf.split("\n\n", 1)
                    else:
                        block, buf = buf.split("\n", 1)
                    for line in block.splitlines():
                        if not line.startswith("data: "):
                            continue
                        try:
                            ev = json.loads(line[6:])
                        except json.JSONDecodeError:
                            continue
                        if ev.get("error"):
                            print(f"ERROR: {ev['error']}")
                            return 1
                        if ev.get("job_id"):
                            job_id = ev["job_id"]
                        if ev.get("storage_project_id"):
                            storage_id = ev["storage_project_id"]
                        elif ev.get("project_id") and str(ev["project_id"]).startswith("reel_"):
                            storage_id = ev["project_id"]
                        evt = ev.get("event", "")
                        if evt == "phase":
                            print(f"  phase: {ev.get('phase')} pct={ev.get('pct')}")
                        elif evt == "progress" and ev.get("msg"):
                            print(f"  … {ev['msg'][:80]}")
                        elif evt == "storyboard_frame":
                            cid = ev.get("clip_id", "?")
                            if ev.get("storyboard_ok"):
                                clips_ok.append(cid)
                                print(f"  OK storyboard {cid} path={ev.get('path', '')[-60:]}")
                            else:
                                clips_fail.append(cid)
                                print(f"  FAIL storyboard {cid}")
                        elif evt == "awaiting_storyboard_approval":
                            terminal = True
                            print("  awaiting_storyboard_approval")
                        if ev.get("terminal"):
                            terminal = True

    if not storage_id and job_id:
        storage_id = f"reel_{job_id}"
    if not storage_id:
        print("Nessun storage_project_id ricevuto")
        return 1

    print(f"\nJob: {job_id}  Storage: {storage_id}")
    time.sleep(1)
    files = check_storyboard_files(storage_id)
    print(f"\nFile su disco ({len(files)}):")
    for f in files:
        flag = "OK" if f["ok"] else "SMALL"
        print(f"  [{flag}] {f['name']} ({f['bytes']} B)")

    all_clips = sorted({*clips_ok, *clips_fail})
    print("\nProbe API storyboard-clip:")
    for cid in all_clips[:12]:
        code = probe_api(storage_id, cid)
        print(f"  {cid}: HTTP {code}")

    ok_files = sum(1 for f in files if f["ok"])
    print(f"\nRiepilogo: SSE ok={len(clips_ok)} fail={len(clips_fail)} | disco reali={ok_files}")
    if clips_fail and not clips_ok:
        return 1
    if ok_files < max(1, len(clips_ok)):
        print("ATTENZIONE: meno file su disco che clip OK in SSE")
    return 0 if ok_files >= 1 and not clips_fail else (1 if clips_fail else 0)


if __name__ == "__main__":
    sys.exit(main())
