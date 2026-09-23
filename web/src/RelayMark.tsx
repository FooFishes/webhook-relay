/**
 * Brand mark: one stroke that steps up — a signal taking a single hop —
 * with the relay lamp lit at the turn.
 * Keep in sync with public/favicon.svg.
 */
export function RelayMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="relay-mark"
    >
      <rect width="24" height="24" rx="6" fill="#0B7A68" />
      <path
        d="M5.5 16h5.5V8h7.5"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="11" cy="8" r="3" fill="#fff" />
    </svg>
  );
}
