# 🎬 CinematicAI Studio

> Automated cinematic video creation powered by AI — LLM storyboarding + ComfyUI generation

Cross-platform desktop app (Windows, macOS, Linux) that turns a text prompt into a full cinematic video by orchestrating LLM storyboarding, AI frame generation, and video synthesis via ComfyUI.

---

## ✨ Features

- **LLM Storyboarding** — Generate scene/shot breakdowns with any LLM (OpenAI, Anthropic, Ollama, LM Studio, Groq)
- **Shot Designer** — Camera angles, lens, movement, mood per shot
- **Frame Generation** — First & last frame images via ComfyUI txt2img
- **Video Synthesis** — WAN 2.1, CogVideoX, AnimateDiff via ComfyUI img2video
- **Multi-Node** — Connect multiple ComfyUI nodes for parallel processing
- **Pipeline Resume** — Resume interrupted pipelines from last checkpoint
- **Cross-Platform** — Windows, macOS, Linux

---

## 🚀 Quick Start

```bash
# 1. Clone & setup
git clone <repo>
cd cinematic-ai-studio
bash scripts/setup.sh

# 2. Configure
nano ~/.cinematic-studio/config.yaml
# Add: LLM API key + ComfyUI node address

# 3. Start
bash scripts/dev.sh
```

### Prerequisites
- **Python 3.11+**
- **Node.js 20+**
- **ComfyUI** running on any machine with GPU
- **FFmpeg** (for final video assembly)
- An LLM API key (or local Ollama)

---

## 🏗️ Architecture

```
Electron (UI) ←→ FastAPI (Python) ←→ ComfyUI Node(s)
                      ↕
              LLM Provider (any)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full diagram.

---

## 🤖 Claude Code Setup

This project is fully configured for autonomous development with Claude Code.

```bash
# Install Claude Code
curl -fsSL https://claude.ai/install.sh | bash

# Open project
cd cinematic-ai-studio
claude

# First command inside Claude Code:
/project-status
```

### Available Commands
| Command | Description |
|---------|-------------|
| `/project-status` | See what's built and what's next |
| `/build-phase 1` | Build foundation (config, DB, API) |
| `/build-phase 2` | Build LLM adapters |
| `/build-phase 3` | Build ComfyUI integration |
| `/build-phase 4` | Build pipeline orchestrator |
| `/build-phase 5` | Build Electron + React UI |
| `/build-phase 6` | Package for distribution |
| `/test-comfyui http://localhost:8188` | Test a ComfyUI node |
| `/gen-storyboard "noir detective in Venice"` | Generate test storyboard |

### Subagents
Claude Code will automatically use specialized agents:
- **storyboard-architect** — storyboard design & validation
- **comfyui-engineer** — ComfyUI API & workflow building
- **llm-adapter-engineer** — LLM provider integration
- **ui-engineer** — Electron + React UI
- **pipeline-orchestrator** — video generation workflow

---

## ⚙️ Configuration

Edit `~/.cinematic-studio/config.yaml`:

```yaml
llm:
  provider: openai      # or: anthropic, ollama, lmstudio, groq
  model: gpt-4o
  api_key: sk-...

comfyui:
  nodes:
    - host: localhost
      port: 8188
      name: "Local GPU"
```

---

## 📁 Project Structure

```
cinematic-ai-studio/
├── .claude/              ← Claude Code configuration
│   ├── CLAUDE.md         ← Agent memory & rules  [DO NOT MOVE]
│   ├── settings.json     ← Permissions & hooks
│   ├── agents/           ← Specialized subagents
│   ├── skills/           ← Reusable knowledge
│   └── commands/         ← Custom slash commands
├── src/
│   ├── core/             ← Python FastAPI backend
│   └── ui/               ← Electron + React frontend
├── config/
│   ├── default.yaml      ← Default configuration
│   └── workflows/        ← ComfyUI workflow templates
├── docs/
│   └── ARCHITECTURE.md
├── scripts/
│   ├── setup.sh
│   └── dev.sh
└── CLAUDE.md             ← Root agent memory  [DO NOT MOVE]
```

---

## 📄 License

MIT
