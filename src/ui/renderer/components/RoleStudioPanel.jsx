import clsx from 'clsx'
import {
  Loader2, Sparkles, Check, X, BookOpen, Clapperboard, Camera, PenLine,
  ClipboardCheck, FlaskConical, CheckCircle2, AlertTriangle,
} from 'lucide-react'

const ROLE_ICONS = {
  story_analyst: BookOpen,
  narrative_director: Clapperboard,
  cinematographer: Camera,
  prompt_engineer: PenLine,
  continuity_checker: ClipboardCheck,
}

function VerifyBadge({ result }) {
  if (!result) return null
  if (result.checking) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-[var(--gold)]">
        <Loader2 size={10} className="animate-spin" /> Verifica…
      </span>
    )
  }
  if (result.pending || result.ok === null) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-[var(--text3)]">
        In coda
      </span>
    )
  }
  if (result.ok) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-[var(--green)]" title={result.message}>
        <CheckCircle2 size={10} />
        {result.load_time_seconds != null
          ? `OK · load ${Number(result.load_time_seconds).toFixed(1)}s`
          : 'OK'}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-[var(--red)]" title={result.message}>
      <AlertTriangle size={10} /> Fallito
    </span>
  )
}

export default function RoleStudioPanel({
  open,
  loading,
  error,
  summary,
  assignments,
  provider,
  modelsCount,
  verifyLoading,
  verifyResults,
  verifySummary,
  onClose,
  onAccept,
  onVerifyModels,
}) {
  if (!open) return null

  const verifyByRole = verifyResults || {}
  const allVerified = verifySummary?.total > 0 && verifySummary.passed === verifySummary.total
  const someVerified = verifySummary?.passed > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div
        className="w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col rounded-lg border border-[var(--border2)] bg-[var(--bg1)] shadow-2xl"
        role="dialog"
        aria-labelledby="role-studio-title"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-[var(--gold)]" />
            <h2 id="role-studio-title" className="font-display text-lg text-[var(--text)]">
              Studio Regia AI
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded text-[var(--text3)] hover:text-[var(--text)] hover:bg-[var(--bg3)]"
            aria-label="Chiudi"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loading && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 size={28} className="text-[var(--gold)] animate-spin" />
              <p className="text-sm text-[var(--text2)]">Analisi modelli e assegnazione agenti…</p>
              <p className="text-[10px] text-[var(--text3)] font-mono">
                Provider: {provider || '—'} · modelli in catalogo
              </p>
            </div>
          )}

          {!loading && error && (
            <div className="p-4 rounded border border-[var(--red)]/40 bg-[var(--red)]/10 text-sm text-[var(--red)]">
              {error}
            </div>
          )}

          {!loading && !error && summary && (
            <>
              <div className="p-3 rounded border border-[var(--gold)]/25 bg-[var(--gold)]/8">
                <p className="text-[10px] uppercase tracking-wider text-[var(--gold)] mb-1.5">
                  Strategia dello studio
                </p>
                <p className="text-sm text-[var(--text2)] leading-relaxed">{summary}</p>
                <p className="text-[10px] text-[var(--text3)] mt-2 font-mono">
                  {provider} · {modelsCount} modelli analizzati
                  {provider === 'lmstudio' && ' · verifica: load → test → unload RAM'}
                </p>
              </div>

              {verifySummary && (
                <p className={clsx(
                  'text-xs px-3 py-2 rounded border',
                  allVerified
                    ? 'border-[var(--green)]/30 bg-[var(--green)]/10 text-[var(--green)]'
                    : someVerified
                      ? 'border-[var(--amber)]/30 bg-[var(--amber)]/10 text-[var(--amber)]'
                      : 'border-[var(--border)] text-[var(--text3)]',
                )}>
                  Verifica modelli: {verifySummary.passed}/{verifySummary.total} superati
                  {verifySummary.current_model && verifyLoading && (
                    <span className="font-mono"> · in corso: {verifySummary.current_model}</span>
                  )}
                  {!allVerified && verifySummary.total > 0 && !verifyLoading && ' — correggi o riprova prima di accettare'}
                </p>
              )}

              <ul className="space-y-2">
                {assignments?.map((a) => {
                  const Icon = ROLE_ICONS[a.role] || Sparkles
                  const vr = verifyByRole[a.role]
                  return (
                    <li
                      key={a.role}
                      className={clsx(
                        'flex gap-3 p-3 rounded-lg border bg-[var(--bg2)]',
                        vr?.ok === true && 'border-[var(--green)]/25',
                        vr?.ok === false && 'border-[var(--red)]/25',
                        (vr?.checking || vr?.pending || vr?.ok === null) && 'border-[var(--gold)]/20',
                        vr == null && 'border-[var(--border)]',
                      )}
                    >
                      <Icon size={16} className="text-[var(--gold)] shrink-0 mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-[var(--text)]">
                            {a.role_label}
                          </span>
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--bg3)] text-[var(--gold)] truncate max-w-full">
                            {a.model}
                          </span>
                          <VerifyBadge result={vr} />
                        </div>
                        {a.rationale && (
                          <p className="text-[11px] text-[var(--text3)] mt-1 leading-snug">
                            {a.rationale}
                          </p>
                        )}
                        {vr?.message && !vr?.checking && (
                          <p className={clsx(
                            'text-[10px] mt-1 font-mono',
                            vr.ok ? 'text-[var(--text3)]' : 'text-[var(--red)]',
                          )}>
                            {vr.message}
                          </p>
                        )}
                        <p className="text-[10px] text-[var(--text3)] mt-1 font-mono">
                          temp {a.temperature} · max {a.max_tokens} tok
                        </p>
                      </div>
                    </li>
                  )
                })}
              </ul>

              <p className="text-[11px] text-[var(--text3)] leading-relaxed">
                Usa <strong className="text-[var(--text2)]">Verifica modelli</strong> per caricare ogni modello sul provider,
                eseguire un prompt di test e scaricarlo dalla RAM (LM Studio).
                Poi accetta per applicare la configurazione personalizzata.
              </p>
            </>
          )}
        </div>

        {!loading && !error && assignments?.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 border-t border-[var(--border)]">
            <button
              type="button"
              onClick={onVerifyModels}
              disabled={verifyLoading}
              className="flex items-center gap-2 px-4 py-2 text-xs rounded border border-[var(--border2)] text-[var(--text2)] hover:border-[var(--gold)] hover:text-[var(--gold)] disabled:opacity-50"
            >
              {verifyLoading
                ? <Loader2 size={14} className="animate-spin" />
                : <FlaskConical size={14} />}
              {verifyLoading ? 'Verifica in corso…' : 'Verifica modelli sul provider'}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs rounded border border-[var(--border)] text-[var(--text2)] hover:border-[var(--text3)]"
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={onAccept}
                className="flex items-center gap-2 px-4 py-2 text-xs rounded bg-[var(--gold)]/20 hover:bg-[var(--gold)]/30 text-[var(--gold)] border border-[var(--gold)]/40"
              >
                <Check size={14} />
                Accetta configurazione regia
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
