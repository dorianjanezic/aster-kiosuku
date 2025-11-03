export function roundToStep(value: number, step?: number): number {
    if (!step || step <= 0) return value;
    const n = Math.round(value / step) * step;
    return Number(n.toFixed(decimals(step)));
}

export function decimals(step: number): number {
    const s = step.toString();
    const idx = s.indexOf('.');
    return idx === -1 ? 0 : (s.length - idx - 1);
}

export function formatDurationMs(totalMs: number): string {
    if (!Number.isFinite(totalMs) || totalMs < 0) return '0ms';
    const ms = Math.floor(totalMs % 1000);
    const totalSeconds = Math.floor(totalMs / 1000);
    const s = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const m = totalMinutes % 60;
    const totalHours = Math.floor(totalMinutes / 60);
    const h = totalHours % 24;
    const d = Math.floor(totalHours / 24);
    const parts: string[] = [];
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    if (s || parts.length === 0) parts.push(`${s}s`);
    return parts.join(' ');
}

export function hoursFromMs(totalMs: number): number {
    if (!Number.isFinite(totalMs)) return 0;
    return totalMs / 3_600_000;
}

export function intervalStringToHours(interval: string): number {
    if (!interval || typeof interval !== 'string') return 1;
    const m = interval.trim().toLowerCase().match(/^(\d+)([mhd])$/);
    if (!m) return 1;
    const value = Number(m[1]);
    const unit = m[2];
    if (!Number.isFinite(value) || value <= 0) return 1;
    switch (unit) {
        case 'm':
            return value / 60;
        case 'h':
            return value;
        case 'd':
            return value * 24;
        default:
            return 1;
    }
}

