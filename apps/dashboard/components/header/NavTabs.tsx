'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Tab = { href: string; label: string }

const tabs: Tab[] = [
    { href: '/', label: 'Dashboard' },
    { href: '/pairs', label: 'Pairs' },
    { href: '/cycles', label: 'Cycles' },
    { href: '/portfolio', label: 'Portfolio' }
]

export function NavTabs() {
    const pathname = usePathname()

    return (
        <nav className="flex items-center gap-1">
            {tabs.map((t) => {
                const isActive = pathname === t.href
                return (
                    <Button
                        key={t.href}
                        asChild
                        variant={isActive ? "default" : "ghost"}
                        size="sm"
                        className={cn(
                            "transition-all duration-200",
                            isActive && "shadow-sm"
                        )}
                    >
                        <Link href={t.href as any}>
                            {t.label}
                        </Link>
                    </Button>
                )
            })}
        </nav>
    )
}


