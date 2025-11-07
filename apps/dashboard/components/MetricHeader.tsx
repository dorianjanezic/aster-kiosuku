"use client"

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function MetricHeader({ label, tip, align = 'right' }: { label: string; tip: string; align?: 'left' | 'right' }) {
    return (
        <Tooltip>
            <TooltipTrigger className={align === 'right' ? 'inline-flex justify-end w-full' : 'inline-flex'}>
                {label}
            </TooltipTrigger>
            <TooltipContent>
                <p>{tip}</p>
            </TooltipContent>
        </Tooltip>
    )
}


