import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Badge } from './ui/badge'
import { TrendingUp, TrendingDown, Minus, DollarSign, BarChart3, Activity } from 'lucide-react'

interface StatsCardProps {
  title: string
  value: string | number
  change?: {
    value: number
    type: 'positive' | 'negative' | 'neutral'
  }
  icon?: 'dollar' | 'chart' | 'activity'
  className?: string
}

export function StatsCard({ title, value, change, icon, className }: StatsCardProps) {
  const formatValue = (val: string | number) => {
    if (typeof val === 'number') {
      if (title.toLowerCase().includes('percent') || title.toLowerCase().includes('return')) {
        return `${val.toFixed(2)}%`
      }
      // Round all monetary values to 2 decimal places
      return `$${val.toFixed(2)}`
    }
    return val
  }

  const getIcon = () => {
    switch (icon) {
      case 'dollar':
        return <DollarSign className="h-4 w-4" />
      case 'chart':
        return <BarChart3 className="h-4 w-4" />
      case 'activity':
        return <Activity className="h-4 w-4" />
      default:
        return null
    }
  }

  const getChangeIcon = () => {
    if (!change) return null

    switch (change.type) {
      case 'positive':
        return <TrendingUp className="h-3 w-3" />
      case 'negative':
        return <TrendingDown className="h-3 w-3" />
      default:
        return <Minus className="h-3 w-3" />
    }
  }

  const getChangeColor = () => {
    if (!change) return ''

    switch (change.type) {
      case 'positive':
        return 'text-green-600'
      case 'negative':
        return 'text-red-600'
      default:
        return 'text-gray-600'
    }
  }

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        {getIcon()}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{formatValue(value)}</div>
        {change && (
          <div className={`flex items-center text-xs ${getChangeColor()}`}>
            {getChangeIcon()}
            <span className="ml-1">
              {change.value > 0 ? '+' : ''}{change.value.toFixed(2)}%
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
