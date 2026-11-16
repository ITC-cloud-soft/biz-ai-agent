export const DISCORD_STYLE_ID = 'xmanrui-dsh-im-discord-settings';

const CSS = String.raw`
.ddc-page { --ddt-accent: var(--dsh-im-brand-discord, #5865f2); --ddt-accent-deep: var(--dsh-im-brand-discord-strong, #4752c4); --ddt-accent-wash: var(--dsh-im-brand-discord-wash, #eef0ff); }
.ddc-avatar { color: #fff; background: var(--dsh-im-logo-discord, #5865f2); }
.ddc-avatar svg { display: block; }
`;

export function installDiscordStyles() {
  if (typeof document === 'undefined') return () => {};
  const existing = document.querySelector(`style[data-plugin-css="${DISCORD_STYLE_ID}"]`);
  if (existing) return () => {};
  const style = document.createElement('style');
  style.dataset.plugin = '@xmanrui/dsh-im';
  style.dataset.pluginCss = DISCORD_STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => style.remove();
}
