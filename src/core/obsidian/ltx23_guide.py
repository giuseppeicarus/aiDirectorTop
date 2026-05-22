"""
Guida LTX 2.3 per Obsidian vault e injection LLM.
Fonti: https://ltx.io/model/model-blog/ltx-2-3-prompt-guide
       https://ltx23.github.io/ltx-2-3-prompt-template/
       https://ltx23.github.io/ltx-2-3-prompt-examples/
"""

from __future__ import annotations

from pathlib import Path

LTX23_GUIDE_REL_PATH = "00-Studio/LTX-2-3-Prompt-Guide.md"

LTX23_GUIDE_MARKDOWN = """# LTX 2.3 — Prompt Guide (memoria sistema)

> Riferimento ufficiale: [LTX 2.3 Prompt Guide](https://ltx.io/model/model-blog/ltx-2-3-prompt-guide)
> Template: [ltx23.github.io template](https://ltx23.github.io/ltx-2-3-prompt-template/)
> Esempi: [ltx23.github.io examples](https://ltx23.github.io/ltx-2-3-prompt-examples/)

**tags:** studio, ltx, prompt-guide, video, ssot

---

## Principi (obbligatori)

1. **Un solo paragrafo fluido**, tempo presente, **4–8 frasi** (circa 70–130 parole).
2. **Ordine fisso** — non mescolare keyword a caso:
   - (1) Tipo inquadratura + soggetto + setting
   - (2) `The lighting is …, creating a/an … atmosphere.`
   - (3) **Una sola** mossa camera + focale (`on a 24mm lens`)
   - (4) **Azione nel tempo** (primi secondi → metà → fine clip; usare `duration_sec`)
   - (5) Micro-movimento ambiente (nebbia, folla, pioggia, luci)
   - (6) **`Sound: …`** — una sola riga finale (audio ambientale / musica / voce)
3. Verbi attivi: walks, dollies, pans, drifts, lifts, turns.
4. **Vietato**: liste, bullet, JSON, "The scene shows…", doppie frasi camera, stack
   `photorealistic / 8k / natural skin texture` (sono per txt2img, non LTX video).

---

## Modalità

### Text → Video (`txt2video`)
Descrivi **scena completa** (soggetto, luogo, luce) perché non c'è frame di riferimento.
Stessa struttura 6 blocchi; la frase 1 può essere più ricca di ambiente.

### Image → Video (`img2video`)
Il **first frame è già l'immagine**. Descrivi solo **cosa cambia**: movimento soggetto, camera, luce che si sposta, audio.
**Non** ridescrivere oggetti/statici già visibili nel frame.

### Image + Audio → Video (`img_audio2video`)
Come img2video + in `Sound:` allinea ritmo/energia al brief musicale (beat, voce, ambient).

### Campo pipeline `ltx_video_prompt`
Stesse regole di img2video / img+audio.

### `motion_prompt` (legacy WAN, max 15 parole)
**Non** usare il formato paragrafo LTX — solo camera + soggetto breve.

---

## Template master

```
[SHOT TYPE] of [SUBJECT] in [SETTING].
The lighting is [LIGHT QUALITY + DIRECTION], creating a [MOOD] atmosphere.
[CAMERA MOVEMENT] on a [LENS]mm lens.
[Timed action: first seconds → mid → end of clip].
[Environment micro-motion].
Sound: [ambient / music / dialogue cues].
```

---

## Esempio img2video (5s, music video intro)

A wide shot of a rap artist in a leather jacket and chains in a dim urban interior.
The lighting is warm directional key light with deep shadows, creating an anticipation atmosphere.
The camera slowly dollies forward on a 24mm lens.
In the first seconds he steps out of shadow with head bowed, then lifts his chin toward lens with deliberate pace.
Background haze drifts subtly in the depth of field.
Sound: muted room tone, distant city hum, low bass pulse under the beat.

---

## Esempio txt2video

A medium shot of a barista in a bright minimalist café at morning.
The lighting is soft natural window light from the left, creating a calm focused atmosphere.
The camera holds steady then eases into a slow push-in on a 50mm lens.
In the first seconds she pours vivid matcha over ice; mid-clip the liquid swirls and catches the light.
Steam rises gently from the cup in the background.
Sound: quiet café ambience, ice clink, soft pour.

---

## Anti-pattern (da correggere sempre)

```
The camera slowly dollies forward in a wide framing, 24mm lens. wide shot full environment,
the rap artist..., cinematic aesthetic. photorealistic cinematic realism, natural skin texture.
Ambient city sound... Sound: ...
```

Problemi: concatenazione, duplicati, testo troncato, keyword still, doppio audio.

---

## Checklist agente "Migliora prompt"

- [ ] 4–8 frasi, un paragrafo
- [ ] Una sola istruzione camera
- [ ] Timeline azione se `duration_sec` noto
- [ ] `Sound:` finale, una volta
- [ ] img2video: niente ridescizione still
- [ ] Inglese per il modello video (salvo dialoghi tra virgolette)

---

## Aggiornamento

Questa nota è la **SSOT** per tutti gli agenti che scrivono o migliorano prompt LTX 2.3 in CinematicAI Studio.
"""


def ensure_ltx23_guide_in_vault(vault_path: Path) -> Path:
    """Scrive/aggiorna la guida nello vault Obsidian."""
    from src.core.obsidian.vault_manager import ObsidianVaultManager

    path = vault_path / LTX23_GUIDE_REL_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or "memoria sistema" not in path.read_text(encoding="utf-8")[:200]:
        path.write_text(LTX23_GUIDE_MARKDOWN, encoding="utf-8")

    dash = vault_path / "00-Studio" / "Dashboard.md"
    if dash.exists():
        text = dash.read_text(encoding="utf-8")
        link = "[[00-Studio/LTX-2-3-Prompt-Guide]]"
        if link not in text:
            dash.write_text(
                text.rstrip() + f"\n- {link}\n",
                encoding="utf-8",
            )
    return path


def read_ltx23_guide_from_vault(vault_path: Path, *, max_chars: int = 6000) -> str:
    p = vault_path / LTX23_GUIDE_REL_PATH
    if p.is_file():
        return p.read_text(encoding="utf-8")[:max_chars]
    return LTX23_GUIDE_MARKDOWN[:max_chars]
