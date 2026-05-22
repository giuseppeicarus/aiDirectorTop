# Obsidian — Single Source of Truth

CinematicAI Studio sincronizza automaticamente un **vault Markdown** collegato a ogni progetto. Obsidian (in Docker) è l’interfaccia grafica; il backend è la fonte operativa per pipeline, retrieval LLM e versioni.

## Cosa viene salvato

Ad **ogni checkpoint** pipeline (e sync finale a job completato) il vault riceve tutto ciò che serve per migliorare le esecuzioni successive.

| Tipo | Path vault | Contenuto |
|------|------------|-----------|
| Progetto | `Projects/{id}/_Project.md` | Hub + link memoria, clip, output |
| Clip (reel/trailer) | `Projects/{id}/Clips/{clip_id}.md` | Prompt, LTX, workflow, seed, lirica slot, piano DP, path frame/video/audio |
| Shot (cinematic) | `Projects/{id}/Shots/{shot_id}.md` | Inquadratura, camera, lighting, prompt, motion |
| Audio | `Projects/{id}/Audio-Timeline.md` | Sezioni, downbeats, master path |
| Analisi audio | `Memory/02-Audio-Analysis.md` | BPM, energie, sezioni librosa |
| Lirica | `Memory/03-Lyric-Timing.md`, `03-Slot-Lyrics.md`, `03-Lyrics-Source.md` | Timing righe, testo per slot, testo utente |
| Story / Vision | `Story-Arc.md`, `Vision.md` | Regia narrativa, visual bible |
| Memoria regia | `Memory/Regia-Memory.md` | Indice SSOT + link a tutte le note |
| **Journal** | `Memory/10-Execution-Journal.md` | **Storico append-only** di ogni fase (clip pronte, BPM, slot EDL) |
| Analisi LLM | `Memory/01-Story-Analysis.md`, `Memory/04-Continuity.md` | Output 5-LLM cinematic |
| Shot list | `Memory/03-Shot-List.md` | Riepilogo inquadrature cinematic |
| Brief / config | `Memory/00-Project-Brief.md`, `Memory/06-Production-Config.md` | Brief, workflow, risoluzione, modelli |
| Riferimenti | `Memory/07-Reference-Images.md` | Path immagini reference |
| **Output finale** | `Memory/08-Final-Deliverable.md` | Video master, durata, path, clip count |
| Reel DP | `Visual-Plans.md`, `EDL.md` | Piano visivo + EDL (con lirica per slot) |
| Workflow | `Projects/{id}/Workflows/{wf_id}.md` | Manifest ComfyUI |
| Versioni | `Projects/{id}/Versions/{clip_id}.jsonl` | Storico snapshot clip per checkpoint |

Ogni nota ha **frontmatter YAML** (machine-readable) e **wikilink** `[[Projects/...]]` per il grafo Obsidian.

## Percorsi

- Vault: `~/.cinematic-studio/obsidian-vault/` (config `obsidian.vault_dir`)
- Progetti pipeline: `~/.cinematic-studio/projects/{project_id}/`

## Sync automatico

Con `obsidian.auto_sync_on_checkpoint: true` (default), **ogni salvataggio checkpoint** aggiorna il vault (thread in background, non blocca la pipeline):

- **Trailer** → checkpoint `trailer_state_{job}.json` + journal
- **Reel** → checkpoint `reel_state_{job}.json` + journal
- **Cinematic** → `pipeline_state.json` + journal

Alla **fine job** (fase `completed` / phase 99) viene eseguito un ultimo sync con `final_deliverable` (path video, durata, clip usate) prima della pulizia checkpoint locale.

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

## Memoria per la regia AI

Ogni stage LLM riceve un bundle filtrato dal vault (`get_regia_memory_for_stage`):

| Stage | Note incluse |
|-------|----------------|
| Story Analyst | Brief, vision, audio, story arc reel |
| Narrative Director | + Story Analysis |
| Cinematographer | Story arc, visual plans, EDL, continuity |
| Prompt Engineer | Arco, shot/clip corrente, visual plans |
| Continuity Checker | Riepilogo shot + report precedente |

La sync usa un **thread di fallback** se non c’è event loop asyncio (non salta più silenziosamente).

## Migliora prompt + agent

`Migliora prompt` con `project_context.project_id` inietta la memoria Obsidian per ruolo (narrative / DP / prompt engineer).

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
