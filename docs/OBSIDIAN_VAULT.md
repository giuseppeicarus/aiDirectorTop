# Obsidian — Single Source of Truth

CinematicAI Studio sincronizza automaticamente un **vault Markdown** collegato a ogni progetto. Obsidian (in Docker) è l’interfaccia grafica; il backend è la fonte operativa per pipeline, retrieval LLM e versioni.

## Cosa viene salvato

| Tipo | Path vault | Contenuto |
|------|------------|-----------|
| Progetto | `Projects/{id}/_Project.md` | Hub + link a clip/shot |
| Clip (reel/trailer) | `Projects/{id}/Clips/{clip_id}.md` | Prompt, motion, LTX, workflow, seed, path frame/video/audio |
| Shot (cinematic) | `Projects/{id}/Shots/{shot_id}.md` | Storyboard LLM, seed first/last frame |
| Audio | `Projects/{id}/Audio-Timeline.md` | Sezioni, downbeats, master path |
| Story / Vision | `Story-Arc.md`, `Vision.md` | Output regia |
| Workflow | `Projects/{id}/Workflows/{wf_id}.md` | Manifest ComfyUI |
| Versioni | `Projects/{id}/Versions/{clip_id}.jsonl` | Storico checkpoint per clip |

Ogni nota ha **frontmatter YAML** (machine-readable) e **wikilink** `[[Projects/...]]` per il grafo Obsidian.

## Percorsi

- Vault: `~/.cinematic-studio/obsidian-vault/` (config `obsidian.vault_dir`)
- Progetti pipeline: `~/.cinematic-studio/projects/{project_id}/`

## Sync automatico

Con `obsidian.auto_sync_on_checkpoint: true` (default), ogni salvataggio checkpoint aggiorna il vault:

- Trailer → `trailer_state_{job}.json`
- Reel → `reel_state_{job}.json`
- Cinematic → `pipeline_state.json`

## Docker Obsidian (no install Windows)

```bash
# Dalla root del repo (imposta vault assoluto)
set CINEMATIC_OBSIDIAN_VAULT=%USERPROFILE%\.cinematic-studio\obsidian-vault
docker compose -f docker/obsidian/docker-compose.yml up -d
```

- GUI: **https://127.0.0.1:3001/** (certificato self-signed — accetta nel browser)
- Prima apertura in Obsidian: **Open folder as vault** → `/vault`

L’app avvia il container all’boot del backend se `obsidian.start_docker_on_app_boot: true` e Docker è nel PATH.

## API

| Endpoint | Uso |
|----------|-----|
| `GET /api/obsidian/status` | Vault path, progetti, stato Docker |
| `POST /api/obsidian/sync/project` | Sync manuale da checkpoint |
| `POST /api/obsidian/search` | Retrieval testuale (stili, agent) |
| `GET /api/obsidian/context?project_id=&clip_id=` | Bundle markdown per LLM |
| `POST /api/obsidian/docker/start` | Avvia container |

## Migliora prompt + agent

`Migliora prompt` e la pipeline LLM possono ricevere `project_context.project_id`: il backend inietta il bundle Obsidian (`get_context_bundle`) per coerenza cinematografica.

## UI

Menu **Obsidian Vault**: stato servizio, avvio/stop Docker, ricerca, sync manuale, apertura cartella vault.

## Config (`~/.cinematic-studio/config.yaml`)

```yaml
obsidian:
  enabled: true
  vault_dir: "obsidian-vault"
  auto_sync_on_checkpoint: true
  start_docker_on_app_boot: true
  web_https_port: 3001
```
