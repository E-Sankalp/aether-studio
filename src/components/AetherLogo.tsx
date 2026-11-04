import React, { useId } from 'react';

interface AetherLogoProps {
  /** Rendered width/height in px of the icon mark. */
  size?: number;
  /** Show the "Aether" wordmark next to the mark. */
  showWordmark?: boolean;
  /** Show the small "Audio Studio" caption under the wordmark. */
  showCaption?: boolean;
  className?: string;
}

/** Vector brand mark: a glowing orb holding a stylised sound-wave. */
export const AetherMark: React.FC<{ size?: number; className?: string }> = ({
  size = 40,
  className,
}) => {
  const uid = useId().replace(/:/g, '');
  const bg = `ae-bg-${uid}`;
  const bar = `ae-bar-${uid}`;
  const glow = `ae-glow-${uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      role="img"
      aria-label="Aether logo"
      className={className}
    >
      <defs>
        <linearGradient id={bg} x1="4" y1="2" x2="44" y2="46" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#e11d48" />
          <stop offset="0.55" stopColor="#f12c4c" />
          <stop offset="1" stopColor="#ff6b3d" />
        </linearGradient>
        <linearGradient id={bar} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#ffe4dc" />
        </linearGradient>
        <radialGradient id={glow} cx="0.3" cy="0.2" r="0.9">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.45" />
          <stop offset="0.6" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Tile */}
      <rect x="2" y="2" width="44" height="44" rx="13" fill={`url(#${bg})`} />
      <rect x="2" y="2" width="44" height="44" rx="13" fill={`url(#${glow})`} />
      <rect
        x="2.5"
        y="2.5"
        width="43"
        height="43"
        rx="12.5"
        stroke="#ffffff"
        strokeOpacity="0.28"
      />

      {/* Orbit ring */}
      <ellipse
        cx="24"
        cy="24"
        rx="17"
        ry="6.5"
        transform="rotate(-24 24 24)"
        stroke="#ffffff"
        strokeOpacity="0.35"
        strokeWidth="1.2"
      />

      {/* Sound-wave bars */}
      <g fill={`url(#${bar})`}>
        <rect x="11" y="20" width="4" height="8" rx="2" />
        <rect x="17.5" y="14" width="4" height="20" rx="2" />
        <rect x="24" y="9" width="4" height="30" rx="2" />
        <rect x="30.5" y="15" width="4" height="18" rx="2" />
        <rect x="37" y="21" width="4" height="6" rx="2" />
      </g>

      {/* Spark */}
      <circle cx="38.5" cy="10.5" r="2" fill="#ffffff" />
      <circle cx="38.5" cy="10.5" r="3.6" fill="#ffffff" fillOpacity="0.25" />
    </svg>
  );
};

export const AetherLogo: React.FC<AetherLogoProps> = ({
  size = 40,
  showWordmark = true,
  showCaption = true,
  className = '',
}) => (
  <div className={`flex items-center gap-2.5 shrink-0 select-none ${className}`}>
    <AetherMark size={size} className="drop-shadow-[0_4px_12px_rgba(241,44,76,0.35)]" />
    {showWordmark && (
      <div className="flex flex-col leading-none">
        <span className="text-[18px] font-extrabold tracking-tight brand-text">Aether</span>
        {showCaption && (
          <span className="mt-1 text-[9px] font-semibold uppercase tracking-[0.24em] text-mute">
            Audio Studio
          </span>
        )}
      </div>
    )}
  </div>
);
