export const QQ_STYLE_ID = 'xmanrui-dsh-im-qq-settings';

const CSS = String.raw`
.dqq-page { --ddt-accent: var(--dsh-im-brand-qq, #1677ff); --ddt-accent-deep: var(--dsh-im-brand-qq-strong, #0958d9); --ddt-accent-wash: var(--dsh-im-brand-qq-wash, #eaf3ff); }
.dqq-avatar, .dqq-brand { color: #fff; background: var(--dsh-im-logo-qq, #1677ff); }
.dqq-avatar svg, .dqq-brand svg { display: block; }
`;

export function installQqStyles() {
  if (typeof document === 'undefined') return () => {};
  const existing = document.querySelector(`style[data-plugin-css="${QQ_STYLE_ID}"]`);
  if (existing) return () => {};
  const style = document.createElement('style');
  style.dataset.plugin = '@xmanrui/dsh-im';
  style.dataset.pluginCss = QQ_STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => style.remove();
}
