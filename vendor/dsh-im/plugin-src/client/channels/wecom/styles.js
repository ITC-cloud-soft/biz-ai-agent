export const WECOM_STYLE_ID = 'xmanrui-dsh-im-wecom-settings';

const CSS = String.raw`
.dwecom-page { --ddt-accent: var(--dsh-im-brand-wecom, #3370ff); --ddt-accent-deep: var(--dsh-im-brand-wecom-strong, #245bdb); --ddt-accent-wash: var(--dsh-im-brand-wecom-wash, #eef4ff); }
.dwecom-avatar, .dwecom-brand { color: var(--dsh-im-logo-wecom, #3370ff); background: #fff; border: 1px solid var(--dsw-alias-border-l2, #e5e6eb); }
.dwecom-avatar svg, .dwecom-brand svg { display: block; }
`;

export function installWecomStyles() {
  if (typeof document === 'undefined') return () => {};
  const existing = document.querySelector(`style[data-plugin-css="${WECOM_STYLE_ID}"]`);
  if (existing) return () => {};
  const style = document.createElement('style');
  style.dataset.plugin = '@xmanrui/dsh-im';
  style.dataset.pluginCss = WECOM_STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => style.remove();
}
