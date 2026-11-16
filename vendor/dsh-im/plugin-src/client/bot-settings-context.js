import * as React from 'react';

// The context of the bot cards: openBotSettings (the more-settings button) and, in the care fork (S1, FORK.md personal mode),
// hiddenSettings: the parts a host leaves out when an employee manages their OWN bot from the business web (the server of
// the host refuses those settings anyway). Names: advanced (the more-settings button), workspace, model, agentPreset,
// contextEnhancement, appSettings (WeCom app proxy / callback base), callbackSecretReset (WeCom app); feishuQr (the Feishu / Lark QR
// flow: scan button, 补全权限 repair QR; the manual form becomes the way in, FORK.md「QR の作成を隠す」). DSH itself passes none.
export const BotSettingsContext = React.createContext(Object.freeze({
  openBotSettings() {},
}));

/** Whether the host hides this part (BotSettingsContext.hiddenSettings). */
export function useSettingHidden(name) {
  const hidden = React.useContext(BotSettingsContext)?.hiddenSettings;
  return Array.isArray(hidden) && hidden.includes(name);
}

/** The component, or nothing when the host hides `name`. */
export function hideable(name, Component) {
  function Hideable(props) {
    return useSettingHidden(name) ? null : React.createElement(Component, props);
  }
  Hideable.displayName = `Hideable(${Component.name || name})`;
  return Hideable;
}
