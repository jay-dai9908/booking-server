/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
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
          textMuted: '#8C8279',
          border: '#EBE5DF',
          sage: '#DDE3D5',
          sageText: '#5A6B4E'
        }
      },
      boxShadow: {
        'warm': '0 8px 24px rgba(139, 91, 67, 0.06)'
      }
    },
  },
  plugins: [],
}
