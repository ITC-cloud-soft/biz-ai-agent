// The Japanese label of an IM platform as a pill (labels from WebKitProvider platformLabels, then the built-in table).
import { useWebKit } from './context.tsx'
import { Pill } from './ui.tsx'

export function PlatformBadge({ platform }: { platform: string }) {
  const { platformLabel } = useWebKit()
  return <Pill tone="info">{platformLabel(platform)}</Pill>
}
