# Script download modelli ComfyUI

Scaricabili da **Impostazioni → SCRIPT MODEL COMFYUI** nell'app.

| File | Piattaforma |
|------|-------------|
| `download_model_comfyui_linux.sh` | Linux |
| `download_model_comfyui_macos.sh` | macOS |
| `download_model_comfyui_windows.ps1` | Windows (PowerShell) |
| `download_model_comfyui_windows.bat` | Windows (avvia il `.ps1`) |

## Uso

1. Copia lo script nella **root di ComfyUI** (dove si trova `main.py`).
2. Esegui lo script: crea `./models/` con sottocartelle `checkpoints`, `loras`, `vae`, ecc.
3. I file già presenti vengono saltati (resume su Linux/macOS/Windows con curl).

Richiede **curl** (Windows 10+, macOS) o **wget** (Linux).
