import { NextResponse } from 'next/server'

export async function GET() {
    try {
        const backend = process.env.BACKEND_BASE_URL || process.env.NEXT_PUBLIC_BACKEND_BASE_URL || process.env.NEXT_PUBLIC_DASHBOARD_BASE_URL
        if (!backend) return NextResponse.json({ summary: { baseBalance: 10000, totalNotional: 0, totalUpnl: 0, equity: 10000 }, positions: [], pairs: [] }, { status: 200 })
        const res = await fetch(new URL('/api/portfolio', backend).toString(), { cache: 'no-store' })
        if (!res.ok) return NextResponse.json({ summary: { baseBalance: 10000, totalNotional: 0, totalUpnl: 0, equity: 10000 }, positions: [], pairs: [] }, { status: 200 })
        const json = await res.json()
        return NextResponse.json(json, { status: 200 })
    } catch (err) {
        return NextResponse.json({ summary: { baseBalance: 10000, totalNotional: 0, totalUpnl: 0, equity: 10000 }, positions: [], pairs: [] }, { status: 200 })
    }
}


