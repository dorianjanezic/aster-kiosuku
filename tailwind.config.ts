import type { Config } from 'tailwindcss'

const config: Config = {
    darkMode: ['class'],
    content: [
        './app/**/*.{ts,tsx}',
        './components/**/*.{ts,tsx}',
        './pages/**/*.{ts,tsx}',
        './src/**/*.{ts,tsx}'
    ],
    theme: {
        extend: {
            colors: {
                border: 'hsl(var(--border))',
                input: 'hsl(var(--input))',
                ring: 'hsl(var(--ring))',
                background: 'hsl(var(--background))',
                foreground: 'hsl(var(--foreground))',
                primary: {
                    DEFAULT: 'hsl(var(--primary))',
                    foreground: 'hsl(var(--primary-foreground))'
                },
                secondary: {
                    DEFAULT: 'hsl(var(--secondary))',
                    foreground: 'hsl(var(--secondary-foreground))'
                },
                destructive: {
                    DEFAULT: 'hsl(var(--destructive))',
                    foreground: 'hsl(var(--destructive-foreground))'
                },
                muted: {
                    DEFAULT: 'hsl(var(--muted))',
                    foreground: 'hsl(var(--muted-foreground))'
                },
                accent: {
                    DEFAULT: 'hsl(var(--accent))',
                    foreground: 'hsl(var(--accent-foreground))'
                },
                popover: {
                    DEFAULT: 'hsl(var(--popover))',
                    foreground: 'hsl(var(--popover-foreground))'
                },
                card: {
                    DEFAULT: 'hsl(var(--card))',
                    foreground: 'hsl(var(--card-foreground))'
                },
                success: {
                    DEFAULT: 'hsl(var(--success))',
                    foreground: 'hsl(var(--success-foreground))'
                },
                warning: {
                    DEFAULT: 'hsl(var(--warning))',
                    foreground: 'hsl(var(--warning-foreground))'
                },
                buy: {
                    DEFAULT: 'hsl(var(--buy))',
                    foreground: 'hsl(var(--buy-foreground))'
                },
                sell: {
                    DEFAULT: 'hsl(var(--sell))',
                    foreground: 'hsl(var(--sell-foreground))'
                },
                link: {
                    DEFAULT: 'hsl(var(--link))',
                    hover: 'hsl(var(--link-hover))'
                }
            }
        }
    },
    plugins: [require('tailwindcss-animate')]
}

export default config


