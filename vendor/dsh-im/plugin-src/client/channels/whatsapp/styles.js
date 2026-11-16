export const WHATSAPP_STYLE_ID = 'xmanrui-dsh-im-whatsapp-settings';

const CSS = String.raw`
.dwa-page { --ddt-accent: var(--dsh-im-brand-whatsapp, #25d366); --ddt-accent-deep: var(--dsh-im-brand-whatsapp-strong, #128c7e); --ddt-accent-wash: var(--dsh-im-brand-whatsapp-wash, #eafbf0); }
.dwa-avatar { color: #fff; background: var(--dsh-im-logo-whatsapp, #25d366); }
.dwa-avatar svg { display: block; }
`;

export function installWhatsappStyles() {
  if (typeof document === 'undefined') return () => {};
  const existing = document.querySelector(`style[data-plugin-css="${WHATSAPP_STYLE_ID}"]`);
  if (existing) return () => {};
  const style = document.createElement('style');
  style.dataset.plugin = '@xmanrui/dsh-im';
  style.dataset.pluginCss = WHATSAPP_STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => style.remove();
}
