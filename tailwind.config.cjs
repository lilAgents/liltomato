/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{astro,html,js,ts}', './public/**/*.js'],
  darkMode: 'class',
  theme: {
    container: { center: true, padding: '16px' },
    extend: {
      colors: {
        white: 'var(--color-white)',
        dark: {
          DEFAULT: 'var(--color-dark)',
          2: '#373737',
          3: '#374151',
          4: '#4B5563',
          5: '#6B7280',
          6: '#9CA3AF',
          7: '#D1D5DB',
          8: '#E5E7EB',
        },
        primary: 'var(--color-primary)',
        'blue-dark': 'var(--color-primary-dark)',
        secondary: 'var(--color-secondary)',
        'body-color': 'var(--color-body)',
        'gray-1': 'var(--color-gray-1)',
        'gray-2': 'var(--color-gray-2)',
        warning: '#FBBF24',
      },
    },
  },
  plugins: [],
};
