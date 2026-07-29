interface LogoProps {
  size?: number
  className?: string
}

/**
 * Hourglass / echo-wave logo mark. Emerald (#4edea3) on the dark
 * surface (#0b1326) — mirrors public/favicon.svg. Used next to (not
 * replacing) the "Chronix" wordmark in the app header.
 */
export default function Logo({ size = 24, className = '' }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Chronix logo"
    >
      <rect width="32" height="32" rx="6" fill="#0b1326" />
      <path d="M10 7H22" stroke="#4edea3" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M10 25H22" stroke="#4edea3" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M10.5 7C10.5 11 15 13.5 16 16C17 18.5 21.5 21 21.5 25"
        stroke="#4edea3"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M21.5 7C21.5 11 17 13.5 16 16C15 18.5 10.5 21 10.5 25"
        stroke="#4edea3"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="1.4" fill="#4edea3" />
      <path d="M13 16a3 3 0 0 1 6 0" stroke="#4edea3" strokeWidth="1" fill="none" opacity="0.6" />
    </svg>
  )
}
