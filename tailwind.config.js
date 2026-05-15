/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/ui/renderer/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg0:     '#07070d',
        bg1:     '#0f0f18',
        bg2:     '#16161f',
        bg3:     '#1e1e2a',
        border:  '#252533',
        border2: '#32324a',
        gold:    '#c9a84c',
        gold2:   '#e6c46a',
        text1:   '#e8e4dd',
        text2:   '#9090a8',
        text3:   '#555568',
      },
      fontFamily: {
        display: ['"Playfair Display"', 'Georgia', 'serif'],
        mono:    ['"JetBrains Mono"', 'monospace'],
        ui:      ['"JetBrains Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
}
