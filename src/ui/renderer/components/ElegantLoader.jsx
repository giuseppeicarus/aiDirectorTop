import { useEffect, useState } from 'react'
import { Loader2, Sparkles, Film, Brain, Cpu, Zap } from 'lucide-react'

const DEFAULT_MESSAGES = [
  'Inizializzazione della pipeline cinematografica…',
  'Verifica dello stato dei nodi GPU ComfyUI…',
  'Orchestrando i registi LLM (Story Analyst, Director, Cinematographer)…',
  'Analisi dei parametri e della struttura narrativa del brief…',
  'Caricamento della Media Library e degli asset di progetto…',
  'Validazione della consistenza visiva del personaggio…',
  'Connessione e polling dei servizi di rendering…'
]

export default function ElegantLoader({ message, messages = DEFAULT_MESSAGES, className }) {
  const [msgIndex, setMsgIndex] = useState(0)

  useEffect(() => {
    if (!messages || messages.length <= 1) return
    const timer = setInterval(() => {
      setMsgIndex((prev) => (prev + 1) % messages.length)
    }, 1800)
    return () => clearInterval(timer)
  }, [messages])

  const activeMessage = message || messages[msgIndex]

  // Get matching icon based on current loading text
  const getIcon = () => {
    const txt = activeMessage.toLowerCase()
    if (txt.includes('gpu') || txt.includes('rendering') || txt.includes('comfyui')) {
      return <Cpu className="text-[#c9a84c] animate-pulse" size={20} />
    }
    if (txt.includes('llm') || txt.includes('story') || txt.includes('narrativa') || txt.includes('analyst')) {
      return <Brain className="text-[#c9a84c] animate-pulse" size={20} />
    }
    if (txt.includes('pipeline') || txt.includes('cinematografica') || txt.includes('director')) {
      return <Film className="text-[#c9a84c] animate-pulse" size={20} />
    }
    if (txt.includes('nodi') || txt.includes('servizi')) {
      return <Zap className="text-[#c9a84c] animate-pulse" size={20} />
    }
    return <Sparkles className="text-[#c9a84c] animate-pulse" size={20} />
  }

  return (
    <div className="flex flex-col items-center justify-center h-full p-8 min-h-[300px]">
      <div className="relative flex items-center justify-center mb-6">
        {/* Double rotating ring effect */}
        <div className="absolute w-20 h-20 rounded-full border-2 border-dashed border-[#c9a84c]/20 animate-[spin_10s_linear_infinite]" />
        <div className="absolute w-16 h-16 rounded-full border-2 border-t-2 border-transparent border-t-[#c9a84c] animate-[spin_1.5s_linear_infinite]" />
        
        {/* Glassmorphic center sphere */}
        <div className="w-12 h-12 rounded-full bg-black/40 backdrop-blur-md border border-[#c9a84c]/30 flex items-center justify-center z-10 shadow-lg shadow-black/80">
          {getIcon()}
        </div>
      </div>

      <div className="max-w-md text-center space-y-2">
        <h3 className="font-['Playfair_Display'] text-[#e8e4dd] text-base tracking-wide flex items-center justify-center gap-2">
          <Loader2 className="animate-spin text-[#c9a84c]" size={14} />
          Caricamento in corso
        </h3>
        
        {/* Rotating live info message with scale and fade animation */}
        <div className="h-10 flex items-center justify-center">
          <p key={activeMessage} className="text-xs font-mono text-[#9090a8] leading-relaxed transition-all duration-500 animate-[fadeIn_0.5s_ease-out]">
            {activeMessage}
          </p>
        </div>
      </div>

      {/* Global CSS animation injected inline to avoid style mismatches */}
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes fadeIn {
          from { opacity: 0; transform: scale(0.97); }
          to { opacity: 1; transform: scale(1); }
        }
      `}} />
    </div>
  )
}
