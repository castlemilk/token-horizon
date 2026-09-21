import React from 'react'

interface RingGaugeProps {
  value: number // 0 to 100
  label: string
  sublabel?: string
  color?: string
  size?: number
}

export const RingGauge: React.FC<RingGaugeProps> = ({ value, label, sublabel, color = '#38bdf8', size = 54 }) => {
  const clamped = Math.max(0, Math.min(100, Math.round(value)))
  const strokeWidth = 5
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (clamped / 100) * circumference

  // Adaptive color based on load
  const strokeColor = clamped > 90 ? '#ef4444' : clamped > 75 ? '#f59e0b' : color

  return (
    <div className="flex items-center gap-2.5">
      <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="rotate-[-90deg]">
          {/* Background track */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke="#27272a"
            strokeWidth={strokeWidth}
            fill="transparent"
          />
          {/* Progress arc */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            fill="transparent"
            className="transition-all duration-500 ease-out"
          />
        </svg>
        <span className="absolute text-[11px] font-mono font-bold text-zinc-100">{clamped}%</span>
      </div>
      <div className="flex flex-col">
        <span className="text-[11px] font-semibold tracking-wider text-zinc-300 uppercase">{label}</span>
        {sublabel && <span className="text-[10px] font-mono text-zinc-400">{sublabel}</span>}
      </div>
    </div>
  )
}
