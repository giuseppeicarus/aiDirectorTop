"""
Test approfondito della pipeline reel — LLM stages senza ComfyUI.

Concept: "CARVE" — automotive commercial, auto sportiva su pista all'alba.
30 secondi, 16:9, stile cinematic luxury automotive.

Esegue:
  1. Reel Director   → narrativa + slot EDL
  2. Cinematographer → piano visivo (DOP)
  3. Prompt Engineer → first_frame/motion prompts
  4. Analisi qualità: LTX 2.3 compliance, coerenza regia, visual continuity
  5. Stampa report dettagliato + issues rilevati
"""

from __future__ import annotations

import asyncio
import json
import math
import re
import sys
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

# ── Path setup ───────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("CINEMATIC_STUDIO_CONFIG", str(ROOT / "config" / "default.yaml"))

# ── Test input ───────────────────────────────────────────────────────────────

BRIEF = """
Spot pubblicitario cinematografico ultra realistico per una lametta da barba premium.

Il reel deve trasmettere lusso, precisione, mascolinità moderna ed eleganza visiva,
con lo stile di una pubblicità di profumo di fascia alta mescolata a un commercial
automotive cinematografico. L'atmosfera deve essere sensuale, sofisticata e potente.

La scena si apre con macro estreme delle lame metalliche della lametta illuminate
da luce cinematografica morbida e riflessi caldi. Gocce d'acqua scorrono lentamente
sull'acciaio lucidato mentre bassi profondi e cinematici accompagnano i movimenti
in slow motion.

Un uomo carismatico con barba curata e capelli scuri si trova all'interno di un
bagno moderno di lusso con marmo nero, specchi appannati, vapore leggero e
illuminazione ambientale calda color ambra.

La rasatura deve risultare visivamente appagante: linee perfettamente pulite,
scorrimento fluido della lametta sulla pelle, rimozione realistica dei peli.

Movimenti camera: macro lens, slow motion, side tracking shot, orbite lente,
rack focus tra occhi e lama, close-up estremi della pelle.

Illuminazione: luce cinematografica premium, riflessi ambra e freddi combinati,
haze volumetrico, pelle leggermente lucida, ombre morbide e profonde.

Stile visivo: ultra realistic cinematic commercial, look ARRI Alexa LF,
lente anamorfica, profondità di campo ridotta, texture della pelle ultra dettagliata.
"""

STYLE = (
    "ultra realistic cinematic commercial, ARRI Alexa LF, anamorphic lens, "
    "shallow depth of field, luxury grooming aesthetic, premium photography, "
    "warm amber and cold steel tones, volumetric haze, 8K detail"
)

DURATION_SEC = 30
ASPECT_RATIO = "9:16"
MAX_CLIP_SEC = 5.0

# ── Helpers ───────────────────────────────────────────────────────────────────

SECTION_WIDTH = 72

def hr(char="─"):
    return char * SECTION_WIDTH

def section(title: str):
    print(f"\n{hr()}")
    print(f"  {title}")
    print(hr())

def ok(msg):   print(f"  ✓  {msg}")
def warn(msg): print(f"  ⚠  {msg}")
def err(msg):  print(f"  ✗  {msg}")
def info(msg): print(f"     {msg}")

# ── LLM wrappers ─────────────────────────────────────────────────────────────

async def _llm_json(system: str, user: str, *, role: str = "narrative_director",
                    temperature: float = 0.65, max_tokens: int = 2048) -> dict:
    from src.core.llm.factory import get_llm_adapter
    from src.core.config import get_config
    cfg = get_config()
    # Always use the base llm config (avoids OpenAI role configs when key missing)
    llm = get_llm_adapter(cfg.llm)
    # All adapters expose generate_json(system, user, temperature, max_tokens) -> dict
    return await llm.generate_json(system, user, temperature=temperature, max_tokens=max_tokens)

# ── Pipeline stages ───────────────────────────────────────────────────────────

async def run_director(brief: str, style: str, duration: int, aspect: str,
                       n_slots: int) -> tuple[dict, list[dict]]:
    from src.core.llm.reel_prompts import REEL_DIRECTOR_SYSTEM, build_reel_director_user_prompt
    user = build_reel_director_user_prompt(
        brief=brief, style=style, aspect_ratio=aspect,
        duration_sec=duration, vision={},
    ) + f"\n\nTarget approximately {n_slots} slots."
    raw = await _llm_json(REEL_DIRECTOR_SYSTEM, user, role="narrative_director",
                          temperature=0.70, max_tokens=2048)
    narrative = {
        "logline":       raw.get("logline", ""),
        "mood":          raw.get("mood", ""),
        "visual_theme":  raw.get("visual_theme", ""),
        "narrative_arc": raw.get("narrative_arc", ""),
        "visual_motifs": raw.get("visual_motifs") or [],
    }
    return narrative, raw.get("slots") or []


async def run_dop(slots: list[dict], style: str, aspect: str, brief: str,
                  narrative: dict) -> dict:
    from src.core.llm.reel_prompts import REEL_CINEMATOGRAPHER_SYSTEM, build_reel_cinematographer_prompt
    from src.core.workflow.reel_pipeline import _normalize_dop_llm_result
    raw = await _llm_json(
        REEL_CINEMATOGRAPHER_SYSTEM,
        build_reel_cinematographer_prompt(slots, style=style, aspect_ratio=aspect,
                                          vision={}, brief=brief,
                                          director_narrative=narrative),
        role="cinematographer", temperature=0.60, max_tokens=4096,
    )
    return _normalize_dop_llm_result(raw)


async def run_prompt_engineer(visual_plans: dict, style: str, aspect: str,
                               narrative: dict) -> dict:
    from src.core.llm.reel_prompts import REEL_PROMPT_ENGINEER_SYSTEM, build_reel_prompt_engineer_user
    from src.core.workflow.reel_pipeline import _normalize_prompt_llm_result
    raw = await _llm_json(
        REEL_PROMPT_ENGINEER_SYSTEM,
        build_reel_prompt_engineer_user(list(visual_plans.values()), style=style,
                                        aspect_ratio=aspect, vision={},
                                        director_narrative=narrative),
        role="prompt_engineer", temperature=0.55, max_tokens=3500,
    )
    return _normalize_prompt_llm_result(raw)


# ── Quality evaluators ────────────────────────────────────────────────────────

LTX_MIN_WORDS = 30      # minimum words in a video prompt for LTX 2.3 quality
LTX_IDEAL_WORDS = 60    # ideal target
LTX_MOTION_KEYWORDS = [
    "camera", "slow", "pan", "push", "pull", "drift", "track", "dolly",
    "zoom", "orbit", "follow", "handheld", "float", "move", "motion", "rotate",
    "glide", "arc", "tilt", "swing", "rack", "focus", "shift", "reveal",
]
LTX_SUBJECT_KEYWORDS = [
    "man", "hand", "razor", "blade", "face", "skin", "water", "foam",
    "mirror", "marble", "steam", "light", "reflection", "drop", "beard",
    "chrome", "metal", "eye", "neck", "shave", "lather",
]

CINEMATIC_QUALITY_KEYWORDS = [
    "cinematic", "anamorphic", "arri", "bokeh", "shallow", "depth",
    "lighting", "warm", "cold", "amber", "shadow", "highlight",
    "realistic", "ultra", "detail", "texture", "photorealistic",
]

NEGATIVE_INDICATORS = [
    "cartoon", "illustration", "anime", "drawing", "digital art",
    "3d render", "cgi", "low quality", "blurry", "watermark",
    "text", "logo", "generic", "stock photo",
]


class PromptReport:
    def __init__(self):
        self.issues: List[dict] = []
        self.scores: List[float] = []

    def add_issue(self, clip_id: str, severity: str, category: str, msg: str, fix: str = ""):
        self.issues.append({
            "clip_id": clip_id, "severity": severity,
            "category": category, "msg": msg, "fix": fix
        })

    def add_score(self, s: float):
        self.scores.append(max(0.0, min(1.0, s)))

    def avg_score(self) -> float:
        return sum(self.scores) / len(self.scores) if self.scores else 0.0

    def critical_count(self) -> int:
        return sum(1 for i in self.issues if i["severity"] == "CRITICAL")

    def warn_count(self) -> int:
        return sum(1 for i in self.issues if i["severity"] == "WARN")


def _word_count(text: str) -> int:
    return len(text.split()) if text else 0


def _kw_density(text: str, keywords: list[str]) -> float:
    t = text.lower()
    hits = sum(1 for kw in keywords if kw in t)
    return hits / len(keywords) if keywords else 0.0


def _check_narrative_coherence(slots: list[dict], narrative: dict) -> list[dict]:
    issues = []
    motifs = [m.lower() for m in (narrative.get("visual_motifs") or [])]
    if not motifs:
        issues.append({"severity": "WARN", "category": "narrative",
                       "msg": "Nessun visual_motif nella narrativa del regista",
                       "fix": "Aggiungere 3-5 motivi visivi ricorrenti"})
        return issues

    role_sequence = [s.get("narrative_role", "") for s in slots]
    has_intro = any("intro" in r for r in role_sequence)
    has_climax = any(r in ("peak", "climax") for r in role_sequence)
    has_resolution = any("resol" in r for r in role_sequence)

    if not has_intro:
        issues.append({"severity": "WARN", "category": "narrative_arc",
                       "msg": "Nessuno slot 'intro' — arco narrativo incompleto",
                       "fix": "Primo slot deve avere narrative_role='intro'"})
    if not has_climax:
        issues.append({"severity": "WARN", "category": "narrative_arc",
                       "msg": "Nessuno slot 'peak/climax' — manca il momento culminante",
                       "fix": "Almeno uno slot deve avere narrative_role='peak'"})
    if not has_resolution:
        issues.append({"severity": "INFO", "category": "narrative_arc",
                       "msg": "Nessuna 'resolution' finale — chiusura narrativa assente",
                       "fix": "Ultimo slot con narrative_role='resolution'"})

    return issues


def evaluate_clip(clip_id: str, slot_id: str, clean: dict,
                  dop: dict, narrative: dict, report: PromptReport) -> None:
    fp = clean.get("first_frame_prompt") or ""
    mp = clean.get("motion_prompt") or ""
    ltx = clean.get("ltx_video_prompt") or ""
    sp = clean.get("scene_prompt") or ""

    score = 1.0

    # ── 1. Frame prompt length ────────────────────────────────────────────
    fp_words = _word_count(fp)
    if fp_words < 30:
        report.add_issue(clip_id, "CRITICAL", "frame_length",
                         f"frame_prompt troppo corto ({fp_words} parole) — ComfyUI ignorerà dettagli chiave",
                         "Espandere a min 40 parole con: soggetto, ambiente, illuminazione, stile fotografico")
        score -= 0.3
    elif fp_words < 50:
        report.add_issue(clip_id, "WARN", "frame_length",
                         f"frame_prompt breve ({fp_words} parole) — ideale >50",
                         "Aggiungere descrizione dettagliata della luce e dell'ambiente")
        score -= 0.1

    # ── 2. LTX 2.3 video prompt quality ──────────────────────────────────
    video_text = ltx if ltx else mp
    ltx_words = _word_count(video_text)

    if ltx_words < LTX_MIN_WORDS:
        report.add_issue(clip_id, "CRITICAL", "ltx_compliance",
                         f"LTX video prompt troppo corto ({ltx_words} parole) — LTX 2.3 richiede 60-150 parole in paragrafo fluente",
                         "Riscrivere come paragrafo fluente: Shot+Scene+Action+Character+Camera+Audio")
        score -= 0.35
    elif ltx_words < LTX_IDEAL_WORDS:
        report.add_issue(clip_id, "WARN", "ltx_compliance",
                         f"LTX video prompt subottimale ({ltx_words} parole) — ideale 60-150",
                         "Aggiungere descrizione del movement della camera e del soggetto")
        score -= 0.15

    # ── 3. Camera movement presente nel video prompt ──────────────────────
    motion_density = _kw_density(video_text, LTX_MOTION_KEYWORDS)
    if motion_density < 0.03:
        report.add_issue(clip_id, "CRITICAL", "camera_motion",
                         "Nessuna keyword di movimento camera nel video prompt",
                         "Aggiungere: 'camera slowly pushes in', 'slow pan', 'tracking shot', etc.")
        score -= 0.20
    elif motion_density < 0.06:
        report.add_issue(clip_id, "WARN", "camera_motion",
                         "Movimento camera scarso nel video prompt",
                         "Descrivere in modo più esplicito la traiettoria e velocità della camera")
        score -= 0.05

    # ── 4. Soggetto specifico riconoscibile ───────────────────────────────
    subject_density = _kw_density(fp + " " + video_text, LTX_SUBJECT_KEYWORDS)
    if subject_density < 0.04:
        report.add_issue(clip_id, "WARN", "subject_specificity",
                         "Soggetto del brief (lametta, rasatura) non chiaramente presente nei prompt",
                         "Includere riferimenti espliciti: 'premium razor blade', 'shaving foam', 'close-up of steel blade'")
        score -= 0.10

    # ── 5. Qualità cinematografica ────────────────────────────────────────
    cine_density = _kw_density(fp, CINEMATIC_QUALITY_KEYWORDS)
    if cine_density < 0.05:
        report.add_issue(clip_id, "WARN", "cinematic_quality",
                         "Pochi termini tecnici fotografici nel frame prompt",
                         "Aggiungere: 'anamorphic', 'ARRI Alexa', 'shallow DOF', 'volumetric light'")
        score -= 0.08

    # ── 6. Negative indicators ────────────────────────────────────────────
    combined = (fp + " " + video_text).lower()
    # Use word boundaries to avoid false positives (e.g. "text" in "texture")
    neg_hits = [kw for kw in NEGATIVE_INDICATORS if re.search(rf"\b{re.escape(kw)}\b", combined)]
    if neg_hits:
        report.add_issue(clip_id, "CRITICAL", "negative_content",
                         f"Parole negative trovate nel prompt POSITIVO: {neg_hits}",
                         "Rimuovere dal prompt positivo — vanno nel negative_prompt")
        score -= 0.25

    # ── 7. DOP coherence (camera language matches emotion) ────────────────
    emotion = (dop.get("emotion") or "").lower()
    shot_type = (dop.get("shot_type") or "").lower()
    cam_move = (dop.get("camera_movement") or "").lower()

    intimacy_emotions = {"intimate", "tender", "close", "personal", "sensual"}
    if any(e in emotion for e in intimacy_emotions):
        if "wide" in shot_type and "close" not in shot_type:
            report.add_issue(clip_id, "WARN", "camera_language",
                             f"Shot type '{shot_type}' non coerente con emozione intima '{emotion}'",
                             "Emozioni intime → close_up o medium_close_up")
            score -= 0.10

    peak_emotions = {"peak", "climax", "powerful", "intense", "dramatic"}
    if any(e in emotion for e in peak_emotions):
        if "static" in cam_move:
            report.add_issue(clip_id, "INFO", "camera_language",
                             f"Camera statica per emozione peak '{emotion}' — poco cinematografico",
                             "Aggiungere movimento dinamico per il momento climax")

    # ── 8. LTX paragrafo fluente (non lista) ─────────────────────────────
    if ltx:
        bullet_count = video_text.count("\n-") + video_text.count("\n•") + video_text.count("- ")
        if bullet_count > 2:
            report.add_issue(clip_id, "CRITICAL", "ltx_format",
                             f"LTX prompt contiene {bullet_count} bullet points — LTX 2.3 vuole testo fluente",
                             "Riscrivere come paragrafo continuo senza liste o trattini")
            score -= 0.20

    # ── 9. Coerenza con narrative motifs ─────────────────────────────────
    motifs = [m.lower() for m in (narrative.get("visual_motifs") or [])]
    if motifs:
        motif_hits = sum(1 for m in motifs if any(word in (fp + sp).lower() for word in m.split()))
        motif_coverage = motif_hits / len(motifs)
        if motif_coverage < 0.2:
            report.add_issue(clip_id, "WARN", "motif_continuity",
                             f"Solo {motif_hits}/{len(motifs)} motivi del regista presenti nei prompt",
                             f"Integrare almeno 1-2 motivi: {', '.join(motifs[:3])}")
            score -= 0.08

    report.add_score(score)


# ── Main ───────────────────────────────────────────────────────────────────────

async def main():
    print("\n" + "═" * SECTION_WIDTH)
    print("  REEL PIPELINE TEST — Prompt Quality Analysis")
    print("  Concept: Luxury Razor Blade Commercial (30s)")
    print("═" * SECTION_WIDTH)

    n_slots = max(3, min(10, int(math.ceil(DURATION_SEC / MAX_CLIP_SEC))))
    print(f"\n  Brief length:  {len(BRIEF.split())} words")
    print(f"  Duration:      {DURATION_SEC}s  |  Aspect: {ASPECT_RATIO}")
    print(f"  Max clip sec:  {MAX_CLIP_SEC}s  →  ~{n_slots} slots expected")
    print(f"  Style:         {STYLE[:80]}…")

    # ── Stage 1: Director ─────────────────────────────────────────────────────
    section("STAGE 1 — Reel Director (narrative + slots)")
    print("  Calling LLM…", flush=True)
    try:
        narrative, slots_raw = await asyncio.wait_for(
            run_director(BRIEF, STYLE, DURATION_SEC, ASPECT_RATIO, n_slots),
            timeout=300.0,
        )
    except asyncio.TimeoutError:
        err("Timeout LLM Director — verifica connessione")
        return
    except Exception as e:
        err(f"LLM Director fallito: {e}")
        import traceback; traceback.print_exc()
        return

    info(f"Logline:   {narrative['logline']}")
    info(f"Mood:      {narrative['mood']}")
    info(f"Arc:       {narrative['narrative_arc'][:120]}…")
    info(f"Motifs:    {', '.join(narrative['visual_motifs'][:5])}")
    print(f"\n  → {len(slots_raw)} slot generati:")
    for i, s in enumerate(slots_raw):
        role_tag = f"[{s.get('narrative_role','?')}]"
        hint_short = (s.get("visual_hint") or "")[:80]
        print(f"     {i+1:02d}. {s.get('slot_id','?')} {role_tag:12s} {s.get('emotion','?'):20s} — {hint_short}")

    # Narrative coherence check
    narc_issues = _check_narrative_coherence(slots_raw, narrative)
    for ni in narc_issues:
        if ni["severity"] == "WARN":
            warn(f"[narrative] {ni['msg']}")
        else:
            info(f"[narrative] {ni['msg']}")

    # Build slot_descs for downstream
    total_w = sum(max(0.1, float(s.get("duration_weight", 1.0))) for s in slots_raw)
    t = 0.0
    slot_descs = []
    for s in slots_raw:
        w = max(0.1, float(s.get("duration_weight", 1.0)))
        dur = DURATION_SEC * (w / total_w)
        slot_descs.append({
            "slot_id": s.get("slot_id", f"slot_{len(slot_descs)+1:03d}"),
            "section_type": "verse",
            "energy": s.get("energy", "medium"),
            "emotion": s.get("emotion", "cinematic"),
            "visual_hint": s.get("visual_hint", ""),
            "duration_sec": round(dur, 2),
            "style": STYLE,
            "narrative_role": s.get("narrative_role", ""),
        })
        t += dur

    # ── Stage 2: DOP (Cinematographer) ───────────────────────────────────────
    section("STAGE 2 — Cinematographer / DOP (piano visivo)")
    print("  Calling LLM…", flush=True)
    try:
        visual_plans = await asyncio.wait_for(
            run_dop(slot_descs, STYLE, ASPECT_RATIO, BRIEF, narrative),
            timeout=300.0,
        )
    except asyncio.TimeoutError:
        warn("Timeout DOP — building from director slots (fallback)")
        from src.core.workflow.reel_pipeline import _build_visual_plans_from_edl
        visual_plans = _build_visual_plans_from_edl(
            slot_descs, style=STYLE, director_narrative=narrative, vision={},
        )
    except Exception as e:
        warn(f"DOP fallito: {e}, uso fallback")
        from src.core.workflow.reel_pipeline import _build_visual_plans_from_edl
        visual_plans = _build_visual_plans_from_edl(
            slot_descs, style=STYLE, director_narrative=narrative, vision={},
        )

    print(f"  → {len(visual_plans)} piani visivi generati")
    for sid, p in visual_plans.items():
        st = p.get("shot_type", "?")
        cm = p.get("camera_movement", "?")
        vd = (p.get("visual_description") or p.get("visual_hint") or "")[:70]
        print(f"     {sid:12s}  [{st:20s}] [{cm:20s}] {vd}")

    # ── Stage 3: Prompt Engineer ──────────────────────────────────────────────
    section("STAGE 3 — Prompt Engineer (frame + video prompts)")
    print("  Calling LLM…", flush=True)
    try:
        prompt_map = await asyncio.wait_for(
            run_prompt_engineer(visual_plans, STYLE, ASPECT_RATIO, narrative),
            timeout=480.0,
        )
    except asyncio.TimeoutError:
        warn("Timeout PE — building from visual plans (fallback)")
        from src.core.workflow.reel_pipeline import _build_prompt_map_from_visual_plans
        prompt_map = _build_prompt_map_from_visual_plans(
            visual_plans, style=STYLE, director_narrative=narrative, vision={},
        )
    except Exception as e:
        warn(f"PE fallito: {e}, uso fallback")
        from src.core.workflow.reel_pipeline import _build_prompt_map_from_visual_plans
        prompt_map = _build_prompt_map_from_visual_plans(
            visual_plans, style=STYLE, director_narrative=narrative, vision={},
        )

    # ── Stage 4: Sanitize & build clips ──────────────────────────────────────
    from src.core.llm.generation_prompt_sanitize import sanitize_trailer_clip_prompts, build_ltx_video_prompt_fallback

    clips_data = []
    for slot in slot_descs:
        pdata = prompt_map.get(slot["slot_id"], {})
        dop   = visual_plans.get(slot["slot_id"], {})
        clean = sanitize_trailer_clip_prompts(pdata, dop, style=STYLE, slot_emotion=slot["emotion"])

        # Ensure ltx_video_prompt exists
        if not clean.get("ltx_video_prompt"):
            clean["ltx_video_prompt"] = build_ltx_video_prompt_fallback(
                dop, style=STYLE, slot_emotion=slot["emotion"],
                duration_sec=slot["duration_sec"],
            )

        clips_data.append({
            "clip_id":   f"clip_{len(clips_data):03d}_{slot['slot_id']}",
            "slot_id":   slot["slot_id"],
            "emotion":   slot["emotion"],
            "duration":  slot["duration_sec"],
            "clean":     clean,
            "dop":       dop,
        })

    # ── Stage 5: Quality Evaluation ───────────────────────────────────────────
    section("STAGE 4 — Quality Evaluation (per-clip analysis)")

    report = PromptReport()
    for c in clips_data:
        evaluate_clip(c["clip_id"], c["slot_id"], c["clean"], c["dop"], narrative, report)

    # Print per-clip details
    for i, c in enumerate(clips_data):
        clean  = c["clean"]
        fp_wc  = _word_count(clean.get("first_frame_prompt") or "")
        ltx_wc = _word_count(clean.get("ltx_video_prompt") or clean.get("motion_prompt") or "")
        fp_short = (clean.get("first_frame_prompt") or "")[:90]
        ltx_short = (clean.get("ltx_video_prompt") or clean.get("motion_prompt") or "")[:90]

        score_for_clip = report.scores[i] if i < len(report.scores) else 0
        score_bar = "█" * int(score_for_clip * 10) + "░" * (10 - int(score_for_clip * 10))
        score_str = f"{score_for_clip:.2f}"

        print(f"\n  {'─'*64}")
        print(f"  {c['clip_id']}  [{c['emotion'][:22]:22s}]  {c['duration']:.1f}s")
        print(f"  Score: [{score_bar}] {score_str}")
        print(f"  frame_prompt ({fp_wc}w):  {fp_short}")
        print(f"  ltx_prompt   ({ltx_wc}w):  {ltx_short}")

    # Print issues grouped by severity
    section("STAGE 5 — Issues Report")
    criticals = [i for i in report.issues if i["severity"] == "CRITICAL"]
    warnings  = [i for i in report.issues if i["severity"] == "WARN"]
    infos     = [i for i in report.issues if i["severity"] == "INFO"]

    if criticals:
        print(f"\n  CRITICAL ({len(criticals)}):")
        for iss in criticals:
            err(f"[{iss['clip_id']}] [{iss['category']}] {iss['msg']}")
            if iss.get("fix"):
                info(f"   FIX: {iss['fix']}")

    if warnings:
        print(f"\n  WARNINGS ({len(warnings)}):")
        for iss in warnings:
            warn(f"[{iss['clip_id']}] [{iss['category']}] {iss['msg']}")
            if iss.get("fix"):
                info(f"   FIX: {iss['fix']}")

    if infos:
        print(f"\n  INFO ({len(infos)}):")
        for iss in infos:
            info(f"[{iss['clip_id']}] [{iss['category']}] {iss['msg']}")

    # Summary
    section("SUMMARY")
    avg = report.avg_score()
    bar = "█" * int(avg * 20) + "░" * (20 - int(avg * 20))
    grade = "A" if avg >= 0.85 else "B" if avg >= 0.70 else "C" if avg >= 0.55 else "D"
    print(f"\n  Pipeline score:  [{bar}]  {avg:.2f}  (Grade {grade})")
    print(f"  Total clips:     {len(clips_data)}")
    print(f"  Critical issues: {report.critical_count()}")
    print(f"  Warnings:        {report.warn_count()}")

    # ── Stage 6: Auto-fix & retest ────────────────────────────────────────────
    if report.critical_count() > 0:
        section("STAGE 6 — Auto-Fix & Retest (miglioramento prompt)")
        print(f"  {report.critical_count()} critical issues trovati — applicando fix automatici…\n")
        improvements = []

        for c in clips_data:
            clean = c["clean"]
            dop   = c["dop"]
            changed = False
            notes  = []

            fp = clean.get("first_frame_prompt") or ""
            ltx = clean.get("ltx_video_prompt") or ""
            mp  = clean.get("motion_prompt") or ""

            # Fix 1: frame_prompt troppo corto → inietta stile cinematic + soggetto
            if _word_count(fp) < 40:
                shot_type = dop.get("shot_type", "close-up")
                cam       = dop.get("camera_movement", "slow push")
                lighting  = dop.get("lighting_mood", "warm amber")
                subject   = "a premium razor blade with ultra-sharp steel blades"
                env       = "luxury black marble bathroom with steam, warm amber lighting"
                fp_new = (
                    f"{shot_type} cinematic shot, {subject}, {env}, "
                    f"{STYLE}, {lighting} illumination, photorealistic, 8K, "
                    f"anamorphic lens, shallow depth of field, volumetric haze, "
                    f"ultra realistic skin texture, water droplets on polished steel"
                )
                if len(fp_new) > len(fp):
                    clean["first_frame_prompt"] = fp_new
                    notes.append(f"frame_prompt: {_word_count(fp)}w → {_word_count(fp_new)}w")
                    changed = True

            # Fix 2: LTX video prompt troppo corto o bullet list
            ltx_text = ltx if ltx else mp
            has_bullets = ltx_text.count("- ") > 2 or ltx_text.count("• ") > 2
            if _word_count(ltx_text) < LTX_IDEAL_WORDS or has_bullets:
                ltx_new = build_ltx_video_prompt_fallback(
                    dop, style=STYLE, slot_emotion=c["emotion"],
                    duration_sec=c["duration"],
                )
                # Append specifics from brief
                ltx_new += (
                    " The camera lingers on polished steel surfaces as water droplets "
                    "catch warm amber light, revealing the razor's precision craftsmanship "
                    "through intimate macro photography."
                )
                clean["ltx_video_prompt"] = ltx_new
                notes.append(f"ltx_prompt: {_word_count(ltx_text)}w → {_word_count(ltx_new)}w (rebuilt from DOP)")
                changed = True

            # Fix 3: Rimuovi negative words dal prompt positivo
            for neg_kw in NEGATIVE_INDICATORS:
                if neg_kw in (clean.get("first_frame_prompt") or "").lower():
                    clean["first_frame_prompt"] = re.sub(
                        rf"\b{re.escape(neg_kw)}\b", "", clean["first_frame_prompt"],
                        flags=re.IGNORECASE,
                    ).strip()
                    notes.append(f"rimosso '{neg_kw}' dal prompt positivo")
                    changed = True

            if changed:
                info(f"{c['clip_id']}: {' | '.join(notes)}")
                improvements.append(c["clip_id"])
            c["clean"] = clean

        # Retest after fixes
        print(f"\n  Retesting {len(improvements)} clip modificate…")
        report2 = PromptReport()
        for c in clips_data:
            evaluate_clip(c["clip_id"], c["slot_id"], c["clean"], c["dop"], narrative, report2)

        avg2 = report2.avg_score()
        bar2 = "█" * int(avg2 * 20) + "░" * (20 - int(avg2 * 20))
        delta = avg2 - avg
        print(f"\n  Score BEFORE fix: [{bar}]  {avg:.2f}")
        print(f"  Score AFTER  fix: [{bar2}]  {avg2:.2f}  (Δ {'+' if delta >= 0 else ''}{delta:.2f})")
        print(f"  Critical after:  {report2.critical_count()} (was {report.critical_count()})")
        print(f"  Warnings after:  {report2.warn_count()} (was {report.warn_count()})")

        remaining = [i for i in report2.issues if i["severity"] == "CRITICAL"]
        if remaining:
            print(f"\n  Remaining criticals:")
            for iss in remaining:
                err(f"  [{iss['clip_id']}] {iss['msg']}")
        else:
            ok("Tutti i critical issues risolti dopo il fix automatico!")

    # ── Save results ──────────────────────────────────────────────────────────
    section("OUTPUT — Salvataggio risultati")
    out_path = Path(__file__).parent / "test_reel_results.json"
    result_data = {
        "brief": BRIEF.strip(),
        "style": STYLE,
        "narrative": narrative,
        "slots": slot_descs,
        "clips": [
            {
                "clip_id": c["clip_id"],
                "slot_id": c["slot_id"],
                "emotion": c["emotion"],
                "duration": c["duration"],
                "first_frame_prompt": c["clean"].get("first_frame_prompt"),
                "motion_prompt":      c["clean"].get("motion_prompt"),
                "ltx_video_prompt":   c["clean"].get("ltx_video_prompt"),
                "scene_prompt":       c["clean"].get("scene_prompt"),
                "negative_prompt":    c["clean"].get("negative_prompt"),
                "dop_shot_type":      c["dop"].get("shot_type"),
                "dop_camera_movement":c["dop"].get("camera_movement"),
                "dop_lighting":       c["dop"].get("lighting_mood"),
            }
            for c in clips_data
        ],
        "quality": {
            "avg_score": round((report2 if report.critical_count() > 0 else report).avg_score(), 3),
            "critical_issues": (report2 if report.critical_count() > 0 else report).critical_count(),
            "warnings": (report2 if report.critical_count() > 0 else report).warn_count(),
        }
    }
    out_path.write_text(json.dumps(result_data, indent=2, ensure_ascii=False), encoding="utf-8")
    ok(f"Risultati salvati in: {out_path}")

    # Full prompt dump
    section("FULL PROMPT DUMP (post-fix)")
    for c in clips_data:
        clean = c["clean"]
        print(f"\n  ── {c['clip_id']} [{c['emotion']}] {c['duration']:.1f}s ──")
        print(f"  FRAME ({_word_count(clean.get('first_frame_prompt',''))}w):")
        print(f"    {clean.get('first_frame_prompt','(empty)')}")
        print(f"  LTX VIDEO ({_word_count(clean.get('ltx_video_prompt','') or clean.get('motion_prompt',''))}w):")
        print(f"    {clean.get('ltx_video_prompt','') or clean.get('motion_prompt','(empty)')}")

    print(f"\n{'═' * SECTION_WIDTH}\n")


if __name__ == "__main__":
    asyncio.run(main())
