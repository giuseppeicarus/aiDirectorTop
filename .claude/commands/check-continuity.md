---
name: check-continuity
description: Esegui il controllo di continuità cinematografica su uno shot list esistente. Usage: /check-continuity {project_id}
---

# Check Continuity: $ARGUMENTS

Esegui il controllo completo di continuità su tutti gli shot del progetto.

## Steps

1. **Leggi lo shot list** dal file `~/.cinematic-studio/projects/$ARGUMENTS/storyboard.json`

2. **Usa il subagente continuity-checker** per analizzare:
   - Continuità personaggi (wardrobe, visual anchor, posizione)
   - Continuità illuminazione (coerenza all'interno delle scene)
   - Continuità location (elementi di sfondo)
   - Continuità narrativa (trigger cambio scena giustificati)
   - Continuità camera (progressione logica shot type)

3. **Per ogni coppia di shot consecutivi** verifica:
   - Il `transition_out` del shot[n] è compatibile con il `transition_in` del shot[n+1]?
   - La `continuity_notes[]` del shot[n] è rispettata nel shot[n+1]?
   - Il `shot_type` del shot[n+1] è logico dopo il shot[n]?

4. **Genera report** con:
   ```
   ✅ Shot approvati: N
   ⚠️  Warning: N (non bloccanti)
   ❌ Errori critici: N (richiedono correzione)
   
   ERRORI CRITICI:
   - shot_002_003 → shot_002_004: personaggio cambia abito (critical)
     Correzione: uniformare wardrobe a "cream linen shirt"
   
   WARNING:
   - shot_001_002 → shot_001_003: due close-up consecutivi senza wide shot (warning)
     Suggerimento: inserire medium shot intermedio
   ```

5. **Se ci sono errori critici**: proponi le correzioni specifiche ai prompt

6. **Salva report** in `~/.cinematic-studio/projects/$ARGUMENTS/continuity_report.json`
