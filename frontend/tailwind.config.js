/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        sg: {
          bg: '#F6F1EA',
          paper: '#FFFDF9',
          ink: '#3E332B',
          muted: '#6F645B',
          line: '#E6DDD2',
          brown: '#8B5B43',
          'brown-hover': '#7A4F3A',
          'brown-soft': '#F1E6DC',
          selected: '#FBF4EE',
          peach: '#E7B4A2',
          'peach-soft': '#F7E3DA',
          'peach-ink': '#8A4A36',
          sage: '#7E9A72',
          'sage-soft': '#E7EEE2',
          'sage-ink': '#5F7A55',
          honey: '#D9A441',
          'honey-soft': '#F6EAD2',
          'honey-ink': '#8A5E1F',
          full: '#C9BFB4',
          'full-soft': '#EEE9E3',
          danger: '#B4553F',
          'danger-soft': '#FBEDE8', // 超時、退款底色
          vent: '#4F7FA0',          // 冷氣出風口圖示
          table: '#EADDCF',         // 平面圖上的桌面
          'line-green': '#06C755',
          frame: '#2A231E',
        },
        brand: {
          50: '#f0fdf4',
          100: '#dcfce7',
          500: '#22c55e',
          600: '#16a34a',
          900: '#14532d',
        },
        wood: {
          bg: '#F7F4F0',
          card: '#FFFFFF',
          primary: '#8B5B43',
          primaryHover: '#7A4F3A',
          textMain: '#3E332B',
          textMuted: '#6F645B',
          border: '#EBE5DF',
          sage: '#DDE3D5',
          sageText: '#5A6B4E'
        }
      },
      fontFamily: {
        display: ['"LXGW WenKai TC"', '"Noto Serif TC"', '"PingFang TC"', 'serif'],
        body: ['"Noto Sans TC"', '"PingFang TC"', '"Microsoft JhengHei"', 'system-ui', 'sans-serif'],
        num: ['Nunito', '"Noto Sans TC"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'warm': '0 8px 24px rgba(139, 91, 67, 0.06)',
        'sg-card': '0 6px 18px rgba(139, 91, 67, 0.10)',
        'sg-pop': '0 4px 12px rgba(139, 91, 67, 0.12)',
      },
      keyframes: {
        'bead-bounce': {
          '0%, 100%': { transform: 'translateY(0)' },
          '30%': { transform: 'translateY(-5px)' },
        },
        'sheet-up': {
          '0%': { transform: 'translateY(100%)' },
          '100%': { transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
      animation: {
        'bead-bounce': 'bead-bounce 1.6s infinite ease-in-out',
        'sheet-up': 'sheet-up 220ms cubic-bezier(.2,.8,.2,1)',
        'fade-in': 'fade-in 180ms ease-out',
      }
    },
  },
  plugins: [],
}
