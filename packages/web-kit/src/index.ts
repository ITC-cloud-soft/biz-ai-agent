// @dsh-bridge/web-kit — React + TypeScript parts for the business web of a DSH Business Bridge system (a library: no app shell,
// no router, no branding). Pure logic: './core' (also re-exported here). Styles: '@dsh-bridge/web-kit/styles.css' (+ im-theme.css).
export * from './core/index.ts'
export { WebKitProvider, useWebKit, renderRich, type WebKitProviderProps, type WebKitValue, type ConfirmOptions, type Toast } from './components/context.tsx'
export {
  Card, Notice, Pill, Button, Switch, Skeleton, ErrorBox, DataTable, Empty, Preparing, PageHeader, TimeField, Icon, useAsync, dateTime,
  DEFAULT_UI, DEFAULT_CLASS_NAMES,
  type Column, type Tone, type IconName, type WebKitUi, type ClassKey, type ClassNames,
  type CardProps, type NoticeProps, type PillProps, type ButtonProps, type SwitchProps, type ErrorBoxProps, type DataTableProps,
  type EmptyProps, type PreparingProps, type PageHeaderProps, type TimeFieldProps, type TextFieldProps, type SelectFieldProps,
  TextField, SelectField,
} from './components/ui.tsx'
export { ImEmbed, ChannelPanel, type ImEmbedProps } from './components/ImEmbed.tsx'
export { ImBotsShell, type ImBotsShellProps } from './components/ImBotsShell.tsx'
export { useLinkCode, useLinkCommand, LinkCodeBox, type LinkCodeHandle } from './components/LinkCode.tsx'
export { WeixinConnect } from './components/WeixinConnect.tsx'
export { NotifyPrefsCard, type NotifyPrefsCardProps } from './components/NotifyPrefsCard.tsx'
export { SnsLinkPage, type SnsLinkPageProps } from './components/SnsLinkPage.tsx'
export { PlatformBadge } from './components/PlatformBadge.tsx'
export { AiProfilePage, type AiProfilePageProps, type AiProfileAgent } from './components/AiProfilePage.tsx'
export {
  createImRuntime, channelDefs, installStyleCapture,
  type ImRuntime, type ImRuntimeOptions, type VendorModules, type WeixinModules, type WeixinUi, type Vendor, type ChannelDef,
  type SettingsTabProps, type RpcCall, type BotSettingsApi, type BotSettingsRequest,
} from './im/runtime.ts'
export { AssistantMarkdown, type AssistantMarkdownProps } from './components/AssistantMarkdown.tsx'
export {
  AssistantAttachmentPicker, useAssistantAttachments,
  type AssistantAttachmentPickerProps, type AssistantAttachmentsHandle, type UseAssistantAttachmentsOptions,
} from './components/AssistantAttachmentPicker.tsx'
export { AttachmentSettingsCard, type AttachmentSettingsCardProps, type AttachmentRoleOption } from './components/AttachmentSettingsCard.tsx'
export { ExternalConnectorsPage, type ExternalConnectorsPageProps } from './components/ExternalConnectorsPage.tsx'
