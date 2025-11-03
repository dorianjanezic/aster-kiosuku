export const metadata = {
    title: 'Aster Dashboard',
    description: 'Advanced pairs trading monitoring dashboard with real-time analytics'
}

import './globals.css'
import { NavTabs } from '@/components/header/NavTabs'
import { Badge } from '@/components/ui/badge'
import { Activity, Zap, Github } from 'lucide-react'
import Image from 'next/image'
import { Outfit } from 'next/font/google'

const outfit = Outfit({
    subsets: ['latin'],
    display: 'swap',
    weight: ['300', '400', '500', '600', '700'],
    variable: '--font-outfit',
})

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" className={outfit.variable}>
            <body className="bg-background text-foreground min-h-screen dark color-white">
                <div className="mx-auto max-w-7xl p-4 lg:p-6">
                    <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 py-6 border-border">
                        <div className="flex items-center gap-3">
                            <div className="flex items-center gap-5">
                                <Image
                                    src="/assets/aster-logo.svg"
                                    alt="Aster Logo"
                                    width={32}
                                    height={8}
                                    className="h-6 w-auto object-contain mt-[5px]"
                                />
                                <h1 className="text-2xl font-normal tracking-tight text-white">Kiosuku Pair Agent</h1>
                            </div>
                            <Badge variant="secondary" className="hidden sm:flex">
                                <Activity className="h-3 w-3 mr-1" />
                                Live
                            </Badge>
                        </div>
                        <div className="flex items-center gap-4">

                            <div className="hidden sm:flex items-center gap-2 text-sm text-muted-foreground">
                                <span className="hidden md:inline">Powered by</span>
                                <Image
                                    src="/assets/grok-logo.svg"
                                    alt="Grok Logo"
                                    width={72}
                                    height={28}
                                    className="h-4 w-auto object-contain opacity-80"
                                />
                            </div>
                            <NavTabs />
                        </div>
                    </header>
                    <main className="fade-in">
                        {children}
                    </main>
                    <footer className="mt-8 border-t border-border pt-4 text-xs text-white/80">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <Image
                                    src="/assets/aster-logo.svg"
                                    alt="Aster Logo"
                                    width={28}
                                    height={7}
                                    className="h-4 w-auto object-contain"
                                />
                                <span>Kiosuku Pair Agent</span>

                            </div>
                            <a
                                href={process.env.NEXT_PUBLIC_GITHUB_URL || 'https://github.com/aster-kiosuku'}
                                target="_blank"
                                rel="noreferrer"
                                aria-label="GitHub Repository"
                                className="text-white/80 hover:text-white"
                            >
                                <Github className="h-4 w-4" />
                            </a>
                        </div>
                    </footer>
                </div>
            </body>
        </html>
    )
}


