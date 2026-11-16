import{a as g,c as f,d as b}from"./chunk-HKGHJVF6.js";import"./chunk-K3EEO6WW.js";import"./chunk-LXXYHQ5R.js";import{f as u}from"./chunk-QMGGZHBU.js";import"./chunk-GWPPCTGA.js";import"./chunk-KRA3BKBD.js";import{b as m}from"./chunk-YWTTRVXO.js";import{p as e}from"./chunk-GAIEKFAI.js";import{a as E}from"./chunk-OVVTHFB6.js";import{b as P}from"./chunk-Y6SLVHK3.js";var s=P(E());var k=`_metadata:
  major_version: 1
display_information:
  name: DeepSeek Harness
  description: Connect Slack conversations to a local DeepSeek Harness agent.
  background_color: "#4A154B"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: DeepSeek Harness
    always_online: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - channels:history
      - files:read
      - files:write
      - groups:history
      - im:read
      - im:write
      - im:history
      - mpim:history
      - reactions:write
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
`,S="https://api.slack.com/apps?new_app=1";var h=f,o=b("Slack"," Socket Mode \u957F\u8FDE\u63A5"),D=o.unwrapRpcResult,I=o.normalizeSnapshot,K=o.presentError;var _="xmanrui-dsh-im-slack-settings",R=String.raw`
.dsl-page { --ddt-accent: var(--dsh-im-brand-slack, #4a154b); --ddt-accent-deep: var(--dsh-im-brand-slack-strong, #321033); --ddt-accent-wash: var(--dsh-im-brand-slack-wash, #f7eef7); }
.dsl-avatar { background: var(--dsh-im-logo-slack, linear-gradient(145deg, #fff, #f8fafb)); border: 1px solid var(--dsh-im-logo-border, #e5e6eb); }
.dsl-avatar svg { display: block; }
.dsl-setup { display: grid; gap: 18px; }
.dsl-guide { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 18px; padding: 16px; border: 1px solid color-mix(in srgb, var(--ddt-accent) 18%, var(--dsw-alias-border-l2, #e5e6eb)); border-radius: 11px; background: color-mix(in srgb, var(--ddt-accent) 4%, var(--dsw-alias-bg-layer-1, #fff)); }
.dsl-guideCopy { min-width: 0; }
.dsl-guideCopy strong { display: block; margin-bottom: 5px; color: var(--dsw-alias-label-primary, #1f2329); font-size: 13px; }
.dsl-guideCopy p { margin: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: 1.6; }
.dsl-guideActions { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.dsl-guideActions .ddt-button { white-space: nowrap; }
.dsl-copyState { color: var(--dsw-alias-state-success-primary, #20a162); }
.dsl-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.dsl-tokenHint { grid-column: 1 / -1; margin: -4px 0 0; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; line-height: 1.55; }
@container (max-width: 680px) {
  .dsl-guide { grid-template-columns: minmax(0, 1fr); }
  .dsl-guideActions { justify-content: flex-start; }
  .dsl-fields { grid-template-columns: minmax(0, 1fr); }
}
`;function x(){if(typeof document>"u")return()=>{};if(document.querySelector(`style[data-plugin-css="${_}"]`))return()=>{};let t=document.createElement("style");return t.dataset.plugin="@xmanrui/dsh-im",t.dataset.pluginCss=_,t.textContent=R,document.head.appendChild(t),()=>t.remove()}function M({busy:a,error:t,onSubmit:C,onCancel:A}){let[i,v]=s.useState(""),[l,w]=s.useState(""),[T,r]=s.useState(!1),d=s.useId(),N=async()=>{try{await navigator.clipboard.writeText(k),r(!0),window.setTimeout(()=>r(!1),2e3)}catch{r(!1)}},L=n=>{n.preventDefault();let c=i.trim(),p=l.trim();!c||!p||a||C?.({botToken:c,appToken:p})};return e("section",{className:"ddt-card dim-surfaceCard dim-credentialPanel dsl-setup","aria-labelledby":d},e("h3",{id:d,className:"dim-credentialTitle"},"\u63A5\u5165 Slack \u673A\u5668\u4EBA"),e("div",{className:"dsl-guide"},e("div",{className:"dsl-guideCopy"},e("strong",null,"\u5148\u7528 Manifest \u521B\u5EFA\u5E76\u914D\u7F6E Slack App"),e("p",null,"\u590D\u5236\u914D\u7F6E\u540E\uFF0C\u5728 Slack \u9009\u62E9 From a manifest\uFF1B\u521B\u5EFA\u5B8C\u6210\u540E\u751F\u6210 connections:write App Token\uFF0C\u5E76\u5C06\u5E94\u7528\u5B89\u88C5\u5230\u5DE5\u4F5C\u533A\u3002")),e("div",{className:"dsl-guideActions"},e("button",{type:"button",className:"ddt-button",onClick:()=>void N(),disabled:a},T?e("span",{className:"dsl-copyState"},"\u5DF2\u590D\u5236 Manifest"):"\u590D\u5236 Manifest"),e("a",{className:"ddt-button",href:S,target:"_blank",rel:"noreferrer"},"\u6253\u5F00 Slack \u521B\u5EFA\u9875"))),e("form",{className:"dim-credentialForm dim-credentialFormSingle",onSubmit:L},e("div",{className:"dsl-fields"},e("label",{className:"dim-credentialField"},e("span",null,"Bot Token"),e("input",{type:"password",value:i,onChange:n=>v(n.target.value),placeholder:"xoxb-\u2026",maxLength:4096,autoCapitalize:"none",autoCorrect:"off",spellCheck:!1,autoComplete:"new-password",disabled:a,required:!0})),e("label",{className:"dim-credentialField"},e("span",null,"App Token"),e("input",{type:"password",value:l,onChange:n=>w(n.target.value),placeholder:"xapp-\u2026",maxLength:4096,autoCapitalize:"none",autoCorrect:"off",spellCheck:!1,autoComplete:"new-password",disabled:a,required:!0})),e("p",{className:"dsl-tokenHint"},"Bot Token \u6765\u81EA OAuth & Permissions\uFF1BApp Token \u6765\u81EA Basic Information\uFF0C\u5E76\u4E14\u5FC5\u987B\u5305\u542B connections:write\u3002")),t?e(m,{error:t}):null,e("div",{className:"ddt-actions dim-viewActions dim-credentialActions"},e("button",{type:"submit",className:"ddt-button","data-kind":"primary",disabled:a||!i.trim()||!l.trim()},a?"\u6B63\u5728\u9A8C\u8BC1\u5E76\u8FDE\u63A5\u2026":"\u9A8C\u8BC1\u5E76\u8FDE\u63A5"),e("button",{type:"button",className:"ddt-button",onClick:A,disabled:a},"\u53D6\u6D88"))))}var y=g({channel:"Slack",endpoints:h,api:o,LogoGlyph:u,installStyles:x,pageClass:"dsl-page",avatarClass:"dsl-avatar",connectionLabel:"Socket Mode \u957F\u8FDE\u63A5",emptyTitle:"\u63A5\u5165 Slack \u673A\u5668\u4EBA",emptyDescription:"\u4F7F\u7528\u5B98\u65B9 App Manifest \u5FEB\u901F\u914D\u7F6E\u673A\u5668\u4EBA\uFF0C\u518D\u586B\u5199 Bot Token \u4E0E App Token \u5EFA\u7ACB\u672C\u5730 Socket Mode \u8FDE\u63A5\u3002",platformLabel:"Slack \u5DE5\u4F5C\u533A",CredentialPanel:M,credentialPayload:({botToken:a,appToken:t})=>({botToken:a,appToken:t}),credentialAriaLabel:"\u4F7F\u7528 Manifest \u548C\u53CC Token \u63A5\u5165 Slack \u673A\u5668\u4EBA",credentialOpenLabel:"\u63A5\u5165\u673A\u5668\u4EBA",credentialCloseLabel:"\u6536\u8D77\u63A5\u5165",credentialNoun:"Bot Token \u4E0E App Token",emptyActionLabel:"\u5F00\u59CB\u63A5\u5165"}),J=y.SettingsTab,Q=y.AccountCard;export{Q as SlackAccountCard,M as SlackCredentialPanel,J as SlackSettingsTab};
