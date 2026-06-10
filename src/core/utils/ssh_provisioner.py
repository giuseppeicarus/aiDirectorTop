"""
SSH Provisioner — trova ComfyUI su nodo remoto, esegue script download modelli.
- Download multi-connessione: aria2c (16 conn) → wget → curl
- File di report JSON su nodo remoto: /tmp/cinematic_provision_report.json
- Streaming live dell'output riga per riga
- Evento finale con report strutturato letto via SFTP
"""

from __future__ import annotations

import asyncio
import io
import json
import re
import time
from typing import AsyncGenerator, Callable, Optional

import structlog

log = structlog.get_logger("ssh.provisioner")

_REPORT_PATH = "/tmp/cinematic_provision_report.json"


# ── Auth helpers ──────────────────────────────────────────────────────────────

def _load_pkey(private_key: str):
    import paramiko
    key_str = private_key.strip()
    for loader in (paramiko.RSAKey, paramiko.ECDSAKey, paramiko.Ed25519Key, paramiko.DSSKey):
        try:
            return loader.from_private_key(io.StringIO(key_str))
        except Exception:
            pass
    raise ValueError("Chiave SSH non valida o tipo non supportato")


def _build_connect_kwargs(
    host: str, port: int, user: str,
    password: Optional[str], private_key: Optional[str],
    timeout: int = 15,
) -> dict:
    kw: dict = {"hostname": host, "port": port, "username": user,
                "timeout": timeout, "banner_timeout": timeout, "auth_timeout": timeout}
    if private_key and private_key.strip():
        kw["pkey"] = _load_pkey(private_key)
        kw["look_for_keys"] = False
        kw["allow_agent"] = False
    elif password:
        kw["password"] = password
        kw["look_for_keys"] = False
        kw["allow_agent"] = False
    else:
        kw["look_for_keys"] = True
        kw["allow_agent"] = True
    return kw


# ── Script builder ────────────────────────────────────────────────────────────

def _get_hf_token() -> str:
    """Legge il token HuggingFace dalla config app."""
    try:
        from src.core.config import get_config
        return get_config().app.hf_token or ""
    except Exception:
        return ""


def _build_provision_script(comfyui_path: str, models: list[dict]) -> str:
    """
    Genera bash script ASCII-only, un blocco inline per modello.
    - Niente array bash, heredoc, IFS, Unicode
    - Compatibile con Ubuntu/Debian/Alpine/CentOS/RunPod
    - Download: aria2c (16 conn) > wget > curl
    - HuggingFace token iniettato per URL hf.co
    - Report JSON: /tmp/cinematic_provision_report.json
    """
    total = len(models)
    comfyui_safe = comfyui_path.replace("'", "'\\''")

    hf_token = _get_hf_token()

    def _q(s: str) -> str:
        """Quotatura bash single-quote safe."""
        return s.replace("'", "'\\''")

    # ── Script v4: integrity check, progress monitor, HTTP error capture ────────
    lines = [
        "#!/bin/bash",
        "# CinematicAI Provisioning v4 - integrity check + progress + HTTP errors",
        "exec 2>&1",
        "",
        f"COMFYUI='{comfyui_safe}'",
        f"REPORT='{_REPORT_PATH}'",
        f"TOTAL={total}",
        "DOWNLOADED=0; SKIPPED=0; ERRORS=0; _FIRST=1",
        "SCRIPT_START=$SECONDS",
        "",
        'echo "=== CinematicAI Provisioning START ==="',
        'echo "[INFO] ComfyUI: $COMFYUI"',
        f'echo "[INFO] Modelli: {total}"',
        'echo "[INFO] $(date -u 2>/dev/null || true)"',
        "[ -n \"$(command -v aria2c 2>/dev/null)\" ] && echo '[INFO] Downloader: aria2c' || { [ -n \"$(command -v wget 2>/dev/null)\" ] && echo '[INFO] Downloader: wget' || echo '[INFO] Downloader: curl'; }",
        'echo ""',
        "",
        'if [ ! -d "$COMFYUI" ]; then',
        '  echo "[ERROR_FATAL] ComfyUI non trovato: $COMFYUI"',
        "  exit 1",
        "fi",
        "",
        f"HF_TOKEN='{_q(hf_token)}'",
        "[ -n \"$HF_TOKEN\" ] && echo '[INFO] Token HuggingFace: configurato' || echo '[WARN] Token HuggingFace: NON configurato (i modelli gated falliranno con 403)'",
        "",
        "# --- Dimensione file locale ---",
        "_fsz() { [ -f \"$1\" ] && wc -c < \"$1\" 2>/dev/null || echo 0; }",
        "",
        "# --- Dimensione file remoto via HEAD (segue redirect, con token HF) ---",
        "_rsize() {",
        "  local _U=\"$1\"",
        "  if command -v curl >/dev/null 2>&1; then",
        "    case \"$_U\" in",
        "      *huggingface.co*)",
        "        if [ -n \"$HF_TOKEN\" ]; then",
        "          curl -sIL --max-time 20 -H \"Authorization: Bearer $HF_TOKEN\" \"$_U\" 2>/dev/null",
        "        else",
        "          curl -sIL --max-time 20 \"$_U\" 2>/dev/null",
        "        fi ;;",
        "      *) curl -sIL --max-time 20 \"$_U\" 2>/dev/null ;;",
        "    esac | grep -i '^content-length:' | tail -1 | tr -d '\\r' | awk '{print $2}'",
        "  else",
        "    echo 0",
        "  fi",
        "}",
        "",
        "# --- Monitor background: emette [PROGRESS_DL] ogni 3s ---",
        "_monitor() {",
        "  local _D=\"$1\" _TOT=\"$2\" _SZ=0 _PCT=0",
        "  while true; do",
        "    sleep 3",
        "    [ ! -f \"$_D\" ] && break",
        "    _SZ=$(wc -c < \"$_D\" 2>/dev/null || echo 0)",
        "    if [ \"$_TOT\" -gt 0 ] 2>/dev/null; then",
        "      _PCT=$(( _SZ * 100 / _TOT ))",
        "      echo \"[PROGRESS_DL] ${_SZ}/${_TOT} ${_PCT}%\"",
        "      [ \"$_SZ\" -ge \"$_TOT\" ] 2>/dev/null && break",
        "    else",
        "      echo \"[PROGRESS_DL] ${_SZ}/0 0%\"",
        "    fi",
        "  done",
        "}",
        "",
        "# --- Downloader con token HF ---",
        "_dlget() {",
        "  local _U=\"$1\" _D=\"$2\" _F=\"$3\" _HDR=\"\"",
        '  mkdir -p "$(dirname "$_D")"',
        '  case "$_U" in *huggingface.co*)',
        '    [ -n "$HF_TOKEN" ] && _HDR="Authorization: Bearer $HF_TOKEN" ;;',
        '  esac',
        '  if command -v aria2c >/dev/null 2>&1; then',
        '    if [ -n "$_HDR" ]; then',
        '      aria2c --no-conf --file-allocation=none --split=16 --max-connection-per-server=16 --min-split-size=1M --max-tries=2 --retry-wait=5 --console-log-level=notice --summary-interval=2 --header="$_HDR" --dir="$(dirname "$_D")" --out="$_F" "$_U"',
        '    else',
        '      aria2c --no-conf --file-allocation=none --split=16 --max-connection-per-server=16 --min-split-size=1M --max-tries=2 --retry-wait=5 --console-log-level=notice --summary-interval=2 --dir="$(dirname "$_D")" --out="$_F" "$_U"',
        '    fi; return $?',
        '  fi',
        '  if command -v wget >/dev/null 2>&1; then',
        '    if [ -n "$_HDR" ]; then',
        '      wget --server-response --progress=dot:mega --no-check-certificate --tries=1 --header="$_HDR" -O "$_D" "$_U" 2>&1',
        '    else',
        '      wget --server-response --progress=dot:mega --no-check-certificate --tries=1 -O "$_D" "$_U" 2>&1',
        '    fi; return $?',
        '  fi',
        '  if command -v curl >/dev/null 2>&1; then',
        '    if [ -n "$_HDR" ]; then',
        '      curl -L --retry 2 -# -H "$_HDR" -o "$_D" "$_U"',
        '    else',
        '      curl -L --retry 2 -# -o "$_D" "$_U"',
        '    fi; return $?',
        '  fi',
        '  echo "[ERROR] Nessun downloader (aria2c/wget/curl)"; return 1',
        "}",
        "",
        "# --- Append al report JSON ---",
        "_rpt() {",
        '  if [ "$_FIRST" = "1" ]; then C=""; _FIRST=0; else C=","; fi',
        '  printf \'%s{"filename":"%s","status":"%s","size_bytes":%s,"elapsed_sec":%d,"message":"%s"}\' "$C" "$1" "$2" "$3" "$4" "$5" >> "$REPORT"',
        "}",
        "",
        "# Init report",
        f'printf \'{{"version":"1","start_time":"%s","comfyui_path":"%s","total":{total},"models":[\' \\',
        '  "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)" "$COMFYUI" > "$REPORT"',
        "",
        # ── Pre-scan: mostra stato di ogni modello prima di scaricare ──────────
        'echo "=== PRE-SCAN: Stato modelli ==="',
        'PRE_PRESENT=0; PRE_MISSING=0',
    ]

    for idx, m in enumerate(models, 1):
        fname    = _q(m["filename"])
        tdir     = _q(m.get("target_dir", "models/checkpoints"))
        raw_file = m["filename"]
        lines += [
            f"FNAME='{fname}'",
            f"TDIR='{tdir}'",
            'DEST="$COMFYUI/$TDIR/$FNAME"',
            'LOCAL_SZ=$(_fsz "$DEST")',
            'if [ "$LOCAL_SZ" -gt 10240 ] 2>/dev/null; then',
            f'  echo "[PRESCAN_OK] ({idx}/{total}) {raw_file} - presente ($((LOCAL_SZ/1024/1024)) MB)"',
            "  PRE_PRESENT=$((PRE_PRESENT+1))",
            "else",
            f'  echo "[PRESCAN_MISS] ({idx}/{total}) {raw_file} - mancante"',
            "  PRE_MISSING=$((PRE_MISSING+1))",
            "fi",
        ]

    lines += [
        'echo "[PRESCAN_SUMMARY] Presenti: $PRE_PRESENT | Da scaricare: $PRE_MISSING | Totale: ' + str(total) + '"',
        'echo ""',
        "",
    ]

    # ── Un blocco per ogni modello ────────────────────────────────────────────
    for idx, m in enumerate(models, 1):
        fname = _q(m["filename"])
        tdir  = _q(m.get("target_dir", "models/checkpoints"))
        url   = _q(m.get("url") or "")
        name  = _q(m.get("name", m["filename"]))

        lines += [
            f"# --- Modello {idx}/{total}: {m['filename']} ---",
            f"FNAME='{fname}'",
            f"TDIR='{tdir}'",
            f"URL='{url}'",
            f"MNAME='{name}'",
            'DEST="$COMFYUI/$TDIR/$FNAME"',
            f'echo "[CHECK] ({idx}/{total}) $MNAME"',
            'mkdir -p "$(dirname "$DEST")"',
            "",
            # Salta se il file è già presente (qualsiasi dimensione > 10 KB)
            'LOCAL_SZ=$(_fsz "$DEST")',
            'if [ "$LOCAL_SZ" -gt 10240 ] 2>/dev/null; then',
            '    echo "[SKIP] $FNAME - presente ($((LOCAL_SZ/1024/1024)) MB)"',
            '    _rpt "$FNAME" "skipped" "$LOCAL_SZ" 0 "presente"',
            "    SKIPPED=$((SKIPPED+1))",
            "fi",
            "",
            'if [ "$LOCAL_SZ" -le 10240 ] 2>/dev/null; then',
            '  if [ -z "$URL" ]; then',
            '    echo "[SKIP] $FNAME - URL non configurato"',
            '    _rpt "$FNAME" "no_url" 0 0 "URL mancante"',
            "    ERRORS=$((ERRORS+1))",
            "  else",
            # Avviso HF senza token
            '    case "$URL" in *huggingface.co*)',
            '      [ -z "$HF_TOKEN" ] && echo "[WARN] $FNAME - URL HuggingFace senza token (possibile 403)" ;;',
            '    esac',
            f'    echo "[DOWNLOAD] ({idx}/{total}) $MNAME"',
            '    echo "[URL] $URL"',
            '    rm -f "$DEST.tmp" "${DEST}.aria2" 2>/dev/null || true',
            '    T=$SECONDS',
            # Ottieni dimensione remota per il monitor
            '    RSZT=$(_rsize "$URL"); RSZT=${RSZT:-0}',
            '    echo "[REMOTE_SIZE] $((RSZT/1024/1024)) MB"',
            # Avvia monitor in background
            '    _monitor "$DEST" "$RSZT" &',
            '    MON_PID=$!',
            '    _dlget "$URL" "$DEST" "$FNAME"',
            '    DL_EXIT=$?',
            '    kill "$MON_PID" 2>/dev/null; wait "$MON_PID" 2>/dev/null',
            '    if [ "$DL_EXIT" -eq 0 ]; then',
            '      SZ=$(_fsz "$DEST")',
            '      EL=$((SECONDS-T))',
            '      echo "[DONE] $FNAME - $((SZ/1024/1024)) MB in ${EL}s"',
            '      _rpt "$FNAME" "downloaded" "$SZ" "$EL" "ok"',
            "      DOWNLOADED=$((DOWNLOADED+1))",
            "    else",
            '      EL=$((SECONDS-T))',
            # Detecta HTTP 403/404 dal body del file se piccolo
            '      ERR_MSG="download fallito"',
            '      if [ -f "$DEST" ] && [ "$(_fsz "$DEST")" -lt 2048 ] 2>/dev/null; then',
            '        ERR_BODY=$(head -c 300 "$DEST" 2>/dev/null | tr -d "\\000-\\037")',
            '        case "$ERR_BODY" in',
            '          *"Access"*|*"Forbidden"*|*"401"*|*"403"*|*"Authorization"*|*"restricted"*|*"authorized list"*|*"gated"*)',
            '            ERR_MSG="HTTP 403 - accetta la licenza su huggingface.co o verifica il token"; echo "[ERROR_AUTH] $FNAME - accesso negato HuggingFace (accetta licenza repo o controlla token)" ;;',
            '          *"Not Found"*|*"404"*|*"Entry Not Found"*|*"Repository Not Found"*)',
            '            ERR_MSG="HTTP 404 - URL non trovato o file rimosso dal repo"; echo "[ERROR_404] $FNAME - URL errato o modello rimosso dal repo HF" ;;',
            '          *) echo "[ERROR] $FNAME - download fallito (exit=$DL_EXIT, body: $(echo $ERR_BODY | head -c 80)) in ${EL}s" ;;',
            '        esac',
            '      else',
            '        echo "[ERROR] $FNAME - download fallito (exit=$DL_EXIT) in ${EL}s"',
            '      fi',
            '      rm -f "$DEST" 2>/dev/null || true',
            '      _rpt "$FNAME" "error" 0 "$EL" "$ERR_MSG"',
            "      ERRORS=$((ERRORS+1))",
            "    fi",
            "  fi",
            "fi",
            'echo ""',
            "",
        ]

    # ── Chiusura report e riepilogo ───────────────────────────────────────────
    lines += [
        "TELAPSED=$((SECONDS-SCRIPT_START))",
        'printf \'],"end_time":"%s","downloaded":%d,"skipped":%d,"errors":%d,"total_elapsed_sec":%d}\' \\',
        '  "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)" \\',
        '  "$DOWNLOADED" "$SKIPPED" "$ERRORS" "$TELAPSED" >> "$REPORT"',
        'echo ""',
        'echo "=== RIEPILOGO ==="',
        'echo "[SUMMARY] Scaricati: $DOWNLOADED | Saltati: $SKIPPED | Errori: $ERRORS | Durata: ${TELAPSED}s"',
        'echo "[REPORT_READY] $REPORT"',
        'echo "=== CinematicAI Provisioning COMPLETE ==="',
        '[ "$ERRORS" -gt 0 ] && exit 1 || exit 0',
    ]

    script = "\n".join(lines) + "\n"
    # Forza LF — previene crash da CRLF su Windows
    return script.replace("\r\n", "\n").replace("\r", "\n")


# ── Line parser ───────────────────────────────────────────────────────────────

_PROGRESS_DL_RE = re.compile(r'\[PROGRESS_DL\]\s+(\d+)/(\d+)\s+(\d+)%')
# aria2c: [#abc123 123MiB/456MiB(27%) CN:16 DL:45MiB ETA:8s]
_ARIA2C_RE = re.compile(
    r'\[#[\w]+ ([\d.]+\w+)/([\d.]+\w+)\((\d+)%\).*?DL:([\d.]+\w+/s).*?ETA:([\w]+)\]'
)
# wget: [space]45%[space]123M[space]2.3MB/s[space]5m  OR  45% 123M ...
_WGET_RE = re.compile(r'(?:(\d+)%|\s+(\d+)%)\s+([\d.]+\w+)\s+([\d.]+\w+/s)\s+(\S+)')


def _parse_line(line: str, total_models: int, completed: int) -> tuple[str, float, dict]:
    """Ritorna (tag, pct, extra_dict) dal parsing di una riga."""
    s = line.strip()
    pct = completed / max(total_models, 1)
    extra: dict = {}

    if s.startswith("[CHECK]"):           return "CHECK",          pct, extra
    if s.startswith("[PRESCAN_OK]"):      return "PRESCAN_OK",     pct, extra
    if s.startswith("[PRESCAN_MISS]"):    return "PRESCAN_MISS",   pct, extra
    if s.startswith("[PRESCAN_SUMMARY]"): return "PRESCAN_SUMMARY",pct, extra
    if s.startswith("[REDOWNLOAD]"):      return "DOWNLOAD",       pct, extra
    if s.startswith("[DOWNLOAD]"):        return "DOWNLOAD",       pct, extra
    if s.startswith("[URL]"):           return "INFO",         pct, extra
    if s.startswith("[REMOTE_SIZE]"):   return "INFO",         pct, extra
    if s.startswith("[DEST]"):          return "INFO",         pct, extra
    if s.startswith("[DONE]"):          return "DONE",         (completed + 1) / max(total_models, 1), extra
    if s.startswith("[SKIP]"):          return "SKIP",         (completed + 1) / max(total_models, 1), extra
    if s.startswith("[ERROR_AUTH]"):    return "ERROR_AUTH",   pct, extra
    if s.startswith("[ERROR_404]"):     return "ERROR_404",    pct, extra
    if s.startswith("[ERROR_FATAL]"):   return "ERROR",        pct, extra
    if s.startswith("[ERROR]"):         return "ERROR",        pct, extra
    if s.startswith("[WARN]"):          return "WARN",         pct, extra
    if s.startswith("[SUMMARY]"):       return "SUMMARY",      pct, extra
    if s.startswith("[REPORT_READY]"):  return "REPORT_READY", 1.0, extra
    if s.startswith("[DOWNLOADER]"):    return "INFO",         pct, extra
    if s.startswith("==="):             return "SYSTEM",       pct, extra
    if s.startswith("[INFO]"):          return "INFO",         pct, extra

    # [PROGRESS_DL] bytes/total pct%  — monitor background
    m = _PROGRESS_DL_RE.search(s)
    if m:
        done_b = int(m.group(1))
        total_b = int(m.group(2))
        file_pct = int(m.group(3))
        extra = {
            "dl_pct": file_pct,
            "dl_done": f"{done_b // 1024 // 1024} MB",
            "dl_total": f"{total_b // 1024 // 1024} MB",
            "speed": "", "eta": "",
        }
        return "PROGRESS", pct + (file_pct / 100) / max(total_models, 1), extra

    # aria2c progress: [#hash X/Y(Z%) CN:N DL:Xspd ETA:Xs]
    m = _ARIA2C_RE.search(s)
    if m:
        extra = {
            "dl_done": m.group(1), "dl_total": m.group(2),
            "dl_pct": int(m.group(3)), "speed": m.group(4), "eta": m.group(5),
        }
        return "PROGRESS", pct + (int(m.group(3)) / 100) / max(total_models, 1), extra

    # wget: [space]45%[space]123M[space]2.3MB/s[space]5m
    m = _WGET_RE.search(s)
    if m:
        wpct = int(m.group(1) or m.group(2))
        extra = {
            "dl_pct": wpct, "dl_done": m.group(3),
            "dl_total": "", "speed": m.group(4), "eta": m.group(5),
        }
        return "PROGRESS", pct + (wpct / 100) / max(total_models, 1), extra

    return "INFO", pct, extra


# ── SSHProvisioner ────────────────────────────────────────────────────────────

class SSHProvisioner:

    @staticmethod
    async def test_connection(
        host: str, port: int, user: str,
        password: Optional[str] = None, private_key: Optional[str] = None,
    ) -> dict:
        def _do() -> dict:
            import paramiko
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            t0 = time.monotonic()
            try:
                client.connect(**_build_connect_kwargs(host, port, user, password, private_key, 10))
                latency_ms = round((time.monotonic() - t0) * 1000, 1)
                client.close()
                return {"ok": True, "latency_ms": latency_ms, "error": None}
            except Exception as exc:
                return {"ok": False, "latency_ms": None, "error": str(exc)}
        try:
            return await asyncio.to_thread(_do)
        except Exception as exc:
            return {"ok": False, "latency_ms": None, "error": str(exc)}

    @staticmethod
    async def find_comfyui(
        host: str, port: int, user: str,
        password: Optional[str] = None, private_key: Optional[str] = None,
    ) -> dict:
        def _do() -> dict:
            import paramiko
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            try:
                client.connect(**_build_connect_kwargs(host, port, user, password, private_key, 15))
                cmd = (
                    "find / -maxdepth 8 -name 'main.py' -path '*/ComfyUI/*' 2>/dev/null | head -5; "
                    "find / -maxdepth 8 -name 'ComfyUI' -type d 2>/dev/null | head -5; "
                    "find /workspace /root /home -maxdepth 5 -name 'main.py' 2>/dev/null "
                    "  | xargs grep -l 'ComfyUI' 2>/dev/null | head -5"
                )
                _, stdout, _ = client.exec_command(cmd, timeout=30)
                raw = stdout.read().decode("utf-8", errors="replace")
                client.close()
                candidates: list[str] = []
                for line in raw.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    if line.endswith("main.py"):
                        parent = line[: line.rfind("/")]
                        if parent and parent not in candidates:
                            candidates.append(parent)
                    elif line not in candidates:
                        candidates.append(line)
                valid = [c for c in candidates if "comfyui" in c.lower()]
                if valid:
                    return {"found": True, "path": valid[0], "candidates": valid, "error": None}
                elif candidates:
                    return {"found": True, "path": candidates[0], "candidates": candidates, "error": None}
                return {"found": False, "path": None, "candidates": [], "error": "ComfyUI non trovato"}
            except Exception as exc:
                return {"found": False, "path": None, "candidates": [], "error": str(exc)}
        try:
            return await asyncio.to_thread(_do)
        except Exception as exc:
            return {"found": False, "path": None, "candidates": [], "error": str(exc)}

    @staticmethod
    async def run_provision(
        host: str, port: int, user: str,
        comfyui_path: str, models: list[dict],
        password: Optional[str] = None, private_key: Optional[str] = None,
        on_line: Optional[Callable[[dict], None]] = None,
    ) -> AsyncGenerator[dict, None]:
        """
        Async generator — streamma ogni riga di output SSH + report finale.
        Eventi: {type, text, tag, pct, elapsed_sec, extra?, model_name?}
        Evento finale: {type:"report", report:{...}, summary:{...}}
        """
        script = _build_provision_script(comfyui_path, models)
        total = len(models)
        t_start = time.monotonic()
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[Optional[dict]] = asyncio.Queue()

        def _put(ev: Optional[dict]) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, ev)

        def _run() -> None:
            import paramiko
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            try:
                client.connect(**_build_connect_kwargs(host, port, user, password, private_key, 20))

                # Carica script via SFTP in modalità binaria (evita CRLF su Windows)
                sftp = client.open_sftp()
                script_path = "/tmp/cinematic_provision.sh"
                script_bytes = script.encode("utf-8")
                with sftp.file(script_path, "wb") as f:
                    f.write(script_bytes)
                sftp.close()

                # Esegui con PTY per output non-buffered
                _, stdout, _ = client.exec_command(
                    f"bash {script_path}", timeout=None, get_pty=True
                )

                completed = 0
                current_model: Optional[str] = None
                report_path: Optional[str] = None

                for raw_line in iter(stdout.readline, ""):
                    text = raw_line.rstrip("\n\r")
                    if not text:
                        continue

                    tag, pct, extra = _parse_line(text, total, completed)

                    # Tracking stato
                    if tag in ("DONE", "SKIP"):
                        completed += 1
                        pct = completed / max(total, 1)
                    elif tag == "DOWNLOAD":
                        # Estrai nome modello dal tag [DOWNLOAD] (N/T) Nome
                        m = re.search(r'\(\d+/\d+\)\s+(.+)', text)
                        current_model = m.group(1).strip() if m else None
                    elif tag == "REPORT_READY":
                        # Estrai path del report
                        m = re.search(r'\[REPORT_READY\]\s+(\S+)', text)
                        report_path = m.group(1) if m else _REPORT_PATH

                    elapsed = round(time.monotonic() - t_start, 1)
                    ev: dict = {
                        "type":        "line",
                        "text":        text,
                        "tag":         tag,
                        "pct":         round(pct, 4),
                        "elapsed_sec": elapsed,
                        "model_name":  current_model,
                    }
                    if extra:
                        ev["extra"] = extra
                    _put(ev)

                # Leggi report JSON via SFTP
                report_data: Optional[dict] = None
                if report_path:
                    try:
                        sftp2 = client.open_sftp()
                        with sftp2.file(report_path, "r") as rf:
                            raw_report = rf.read()
                        sftp2.close()
                        report_data = json.loads(raw_report)
                    except Exception as re_exc:
                        log.warning("provision_report_read_failed", error=str(re_exc))

                client.close()

                elapsed = round(time.monotonic() - t_start, 1)
                _put({
                    "type":        "complete",
                    "text":        f"=== Provisioning terminato in {elapsed}s ===",
                    "tag":         "SYSTEM",
                    "pct":         1.0,
                    "elapsed_sec": elapsed,
                    "model_name":  None,
                    "report":      report_data,
                })

            except Exception as exc:
                elapsed = round(time.monotonic() - t_start, 1)
                log.error("provision_ssh_error", error=str(exc))
                _put({
                    "type": "error", "text": f"SSH Error: {exc}",
                    "tag": "ERROR", "pct": 0.0, "elapsed_sec": elapsed,
                    "model_name": None, "report": None,
                })
            finally:
                _put(None)

        fut = loop.run_in_executor(None, _run)

        while True:
            ev = await queue.get()
            if ev is None:
                break
            if on_line:
                try:
                    on_line(ev)
                except Exception:
                    pass
            yield ev

        try:
            await fut
        except Exception as exc:
            log.error("provision_thread_join_error", error=str(exc))


provisioner = SSHProvisioner()
