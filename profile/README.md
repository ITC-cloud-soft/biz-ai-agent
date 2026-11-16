# DSH product profile (template and installer)

A business system's AI plane runs on DSH with a **product profile**: an allow-listed, version-pinned set of bundles and a patch
layer that closes everything an embedded AI employee must not have. This directory is the generic template of that profile and the
script that installs it into an isolated DSH home.

| path | what |
|---|---|
| `template/package.json` | bundles (allow-list, pinned) and their `file:` sources; `{{FRAMEWORK_ROOT}}` is replaced by `install.mjs`. `dshBridge.expectedDsh` = the pinned DSH CLI version, `dshBridge.delegation` = the plugin entry that carries the automatic-task delegation (default `bridge-tools` / `@dsh-bridge/plugin-tools`; `aliases: [<earlier id>]` also reads and removes a delegation an earlier profile wrote under another entry id, and rewrites it into this entry) |
| `template/cordis.patch.yml` | patch layer: plugin manager / terminal / open-in-app / coding presets off, dsh-im (fork), the `bridge-apps` registry with **placeholders** (`<application-id>`, `<アプリ名>`, `<namespace>`, `<APP>_API_URL` ...), the `@dsh-bridge/plugin-*` settings, one generic AI employee preset (`business-assistant`) |
| `template/cordis.yml`, `template/pnpm-workspace.yaml` | DSH profile boilerplate |
| `template/proactive.config.json` | dsh-proactive defaults (Japanese prompts, Asia/Tokyo quiet hours); copied once, never over the admin's own settings |
| `template/auto-tasks/` | automatic task templates and their format (`auto-tasks/README.md`); one generic template for the example manifest |
| `scripts/install.mjs` | installer (below) |
| `scripts/check.mjs` | `node profile/scripts/check.mjs <cordis.patch.yml> [--allow <rule>,...] [--template]` (bin `dsh-bridge-profile-check`): the closed product values of a product profile — every outbound switch at its product value (a value of the entry, or under `applications.<id>`), no open value (an opt-in needs `--allow <rule>`), the bundled coding presets disabled, no `<placeholder>` left (`--template` for the template itself), and a link-guard URL for every application of bridge-apps (`linkGuard.webUrl` for the default one, `linkGuard.webUrls.<id>` for the others). exit 0 / 1 / 2. Run it on your own product profile (docs/GUIDELINE.md 完了の条件) |
| `scripts/patch-preserve.mjs` | keeps model settings saved from the settings UI and the automatic-task delegation across reinstalls |

Bundles: DSH itself (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, shipped with the CLI), the forks in `vendor/`
(`@care/dsh-im`, `@care/dsh-proactive`, `@care/dsh-auto-tasks`; package names kept from the fork), `@dsh-bridge/dsh-core`
(`bridge-apps`) and `@dsh-bridge/plugin-identity` / `-tools` / `-events` / `-notify` / `-approvals` / `-assistant` / `-memory` / `-persona`
(each bundle inserts its own entry: `bridge-memory` = long-term memory, `bridge-persona` = the AI employee's profile; both work without
settings and fall back gracefully when the business system has no `pii-scan` / `ai-profile`). No community plugins (skins, pets,
DSH's community memory, browser bridge, migration, workbench ...); the settings UI cannot add any (plugin manager closed).
A language pack (e.g. Japanese UI) is a product decision and not part of the template.

## Making a product profile

1. Copy `template/` into your product (e.g. `my-product/dsh-profile/`).
2. Replace every `<placeholder>` in `cordis.patch.yml`: the application id = the manifest `system.id`, its display name (used in
   【アプリ名】 and the signature `— <アプリ名> AI 秘書`; with the AI employee's nickname from the business system
   `— <呼び名>（<アプリ名> AI 秘書）`), the tool namespace, the environment variable names of its API URL and service
   token, its bots. Adjust the preset persona to your business, but keep its fixed rules (bridge-persona repeats them before the
   administrator's profile; nickname, tone and company introduction belong in the business system's 「AI 社員の設定」, not in the patch).
   `install.mjs` lists placeholders that are still there.
3. Keep `{{FRAMEWORK_ROOT}}` in `package.json` (or replace the `file:` specs with published versions).
4. Add automatic task templates under `auto-tasks/` if the deployment owns any (`auto-tasks/README.md`).

## Installing (isolated home)

```sh
node profile/scripts/install.mjs [--source <profile dir>] [--home <dir>] [--profile <name>] [--framework-root <dir>] [--skip-install]
#   defaults: --source profile/template  --home <framework>/.dsh-home  --profile bridge
```

- Copies the profile into `$DSH_HOME/profiles/<name>/` (filling `{{FRAMEWORK_ROOT}}`), then runs `dsh plugin --profile <name> install`
  (pnpm in the profile directory). `--skip-install` copies only (DSH hot-reloads the patch).
- **Refuses the personal `~/.dsh`** (and anything inside it) and the shipped profile names (`web`, `headless`, `tui`, ...).
  `DSH_AGENTS_HOME` is `<home>/agents` (DSH never reads `~/.agents`).
- Settings saved from the settings UI are written back to the installed `cordis.patch.yml`. On reinstall, if it changed since the
  last install, a `.bak-<time>` copy is kept first. **Model settings** (`agent-default-model`, `llm-pi-ai`, `llm-deepseek`,
  `llm-deepseek-account`) are carried over (`patch-preserve.mjs`); API keys live in `.credentials.yaml` and are never overwritten.
- Automatic tasks: every install imports `auto-tasks/*.json` and `auto-tasks/proposals/*.json` into `$DSH_HOME/auto-tasks/tasks.json`
  (template-owned fields overwritten, operational fields kept). New tasks are off.
  `--enable-auto-tasks [ids]` / `--disable-auto-tasks [ids]`; `--auto-task-delegate <platform>:<userId>[:<teamId>] | off` writes or
  removes the delegation (`bridge-tools` `unattendedPolicy: delegate` + `unattendedOnBehalfOf`) in the installed patch — inside the
  product's own top-level `bridge-tools` entry (the template ships one with `groupChat: deny`; put your `toolModules` there), otherwise as
  an entry at the end — and keeps it on reinstall. Per delegation class (the playbook's `delegation` / the template's `source.delegation`):
  `--auto-task-delegate planning=<platform>:<userId>,billing=<platform>:<userId>,inspector=each[,default=<platform>:<userId>]` writes
  `unattendedDelegates` (`<class>=each`: each run of such a playbook acts with the delegation the business system issues for the person
  of its triggering event; a template with a per-person delegation is enabled only by name, and the installer warns while its class is
  not opted in). The installer cannot see business roles: choose narrow delegates (bridge-tools `unattendedWarnRoles` warns at run time).
  Manifest playbooks that bridge-events deployed (`pb_<application-id>_<playbook>`, disabled when new) are enabled **by
  name** once DSH has deployed them (`--enable-auto-tasks pb_equipment-inspection_overdue_followup`); the playbook's `agent` becomes the
  preset of its dedicated conversation, so the profile must define that preset.
- **Refuses `--auto-task-session` / `--auto-task-bot` / `--auto-task-target`** (exit 2, nothing installed): the legacy binding to an
  existing conversation and a **fixed delivery target** that no business recipient rule checks. Automatic-task reports go only to the
  recipients the business system resolves (bridge-notify audience); the templates open their own conversation (`sessionPreset`). Same as
  ケアビリング's installer.
- **The template is closed by default**: `cordis.patch.yml` ships the product values of every outbound switch (`docs/ARCHITECTURE.md` §7.2,
  `docs/GUIDELINE.md` d.8; checked by `scripts/check.mjs`, on the template by `scripts/template.test.mjs`): dsh-im `forwardPluginSources: []`; dsh-proactive `modelTools: reclaim`,
  `deliveryGuard: required`; dsh-auto-tasks `restrictDelivery: true`, `mail: false`; bridge-identity `groupChat: deny` + `messages.groupChat`
  (`GROUP_CHAT_GUIDE`); bridge-tools `groupChat: deny`; bridge-notify `audienceFallback: none`, `audienceText: template` (every application;
  `applications.<id>` overrides), `proactiveDelivery: deny`, `aiReportGuard: screen`. The plugin / fork defaults stay the upstream (open)
  ones, so keep these lines; a system that wants an open setting changes that line in its product patch explicitly (opt in).
- `dsh-proactive` reads `$DSH_HOME/proactive/config.json`; the template's defaults are copied only when it does not exist.
- Warns when `dsh --version` differs from `dshBridge.expectedDsh`.

## Starting

The working directory is the isolated home (DSH also reads a `.env` in its cwd, so never start it in a repository root):

```sh
cd <home>
DSH_HOME=<home> DSH_AGENTS_HOME=<home>/agents BRIDGE_DSH_WORKSPACE=<home>/workspace \
<APP>_API_URL=http://127.0.0.1:<port> <APP>_SERVICE_TOKEN=<from your secret store> \
dsh --profile <name> --no-open --host 127.0.0.1 --port 3180 --public-url http://127.0.0.1:3010/dsh/
```

DSH prints one `dsh web: <public-url>?token=...` line: that token is the DSH owner credential (new per process). Never give it to a
browser; the business web opens DSH only through `@dsh-bridge/gateway` (or let the gateway supervise DSH: `DSH_SUPERVISE=1`).

## Tests

`pnpm test:profile` (= `node --test scripts/*.test.mjs` here): patch preservation, the template tasks against the example manifest,
and `install.mjs --skip-install` into temporary homes.
