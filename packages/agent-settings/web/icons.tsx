// A small line-icon set (24 × 24, stroke 1.8; lucide-style paths), so the app needs no icon library.
const P: Record<string, string[]> = {
  gauge: ['M12 14l3.5-3.5', 'M3.5 18a9 9 0 1 1 17 0'],
  cpu: ['M9 3v2', 'M15 3v2', 'M9 19v2', 'M15 19v2', 'M3 9h2', 'M3 15h2', 'M19 9h2', 'M19 15h2', 'M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z', 'M9.5 9.5h5v5h-5z'],
  book: ['M4 19.5V5a2 2 0 0 1 2-2h13v16H6.5A2.5 2.5 0 0 0 4 21.5', 'M19 17v4H6.5', 'M8 7h7', 'M8 11h5'],
  chat: ['M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.2A8 8 0 1 1 21 12Z', 'M8.5 12h.01', 'M12 12h.01', 'M15.5 12h.01'],
  sparkle: ['M12 3l1.8 4.9L19 9.7l-4.6 2.6L12 18l-2.4-5.7L5 9.7l5.2-1.8Z', 'M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8Z'],
  search: ['M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z', 'M20 20l-4-4'],
  vector: ['M4 18l6-6 4 4 6-8', 'M4 6h.01', 'M4 12h.01', 'M20 18h.01'],
  graph: ['M6 7a2 2 0 1 0 0-.01', 'M18 6a2 2 0 1 0 0-.01', 'M12 18a2 2 0 1 0 0-.01', 'M7.7 7.8l3.2 8.4', 'M16.4 7.4l-3.3 8.8', 'M8 6.5h8'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z', 'M14 3v5h5', 'M9 13h6', 'M9 17h4'],
  upload: ['M12 16V4', 'M7 9l5-5 5 5', 'M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  key: ['M15 7a4 4 0 1 0-3.7 5.5L4 20v-3h3v-3h3l1.3-1.3A4 4 0 0 0 15 7Z', 'M16 7.5h.01'],
  plug: ['M9 2v6', 'M15 2v6', 'M6 8h12v3a6 6 0 0 1-12 0Z', 'M12 17v5'],
  shield: ['M12 3l8 3v6c0 4.5-3.4 8.1-8 9-4.6-.9-8-4.5-8-9V6Z', 'M9 12l2 2 4-4'],
  bell: ['M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8', 'M10.3 21a1.9 1.9 0 0 0 3.4 0'],
  link: ['M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1', 'M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1'],
  refresh: ['M20 11a8 8 0 0 0-14.8-3.8L3 9', 'M3 4v5h5', 'M4 13a8 8 0 0 0 14.8 3.8L21 15', 'M21 20v-5h-5'],
  alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M3 12h18', 'M12 3a14 14 0 0 1 0 18', 'M12 3a14 14 0 0 0 0 18'],
  database: ['M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3Z', 'M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5', 'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'],
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
  x: ['M6 6l12 12', 'M18 6 6 18'],
}

export function Icon({ name, size = 18, className }: { name: keyof typeof P | string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {(P[name] ?? []).map((d) => <path key={d} d={d} />)}
    </svg>
  )
}
