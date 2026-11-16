# 06 Register in the DSH product profile and enable automatic tasks

Sources of truth: `docs/GUIDELINE.en.md` b.5, b.7, a.4, d.7, d.8, `<framework>/profile/template/cordis.patch.yml` (samples in its comments), `profile/template/auto-tasks/README.md`, `plugins/*/README.md`.

## 1. Copy the profile and fill it in

1. Copy `<framework>/profile/template/` into your own product (e.g. `<product>/dsh-profile/`) and fill in every `<placeholder>` in `cordis.patch.yml`
   (`<…>` inside YAML comments is not counted). Delete the template's `auto-tasks/example-report-overdue.json` (a task of the sample app) or replace it with your own task.
2. Create the **app bot** and note its `botId` (Slack App, LINE Official Account, Teams Bot, WeCom self-built app, Lark app. Personal WeChat allows one bot per account, so use `multiApp: true` for several apps).
   Have the user enter the bot's credentials.
3. Write the **registry** (`bridge-apps`):

```yaml
- id: bridge-apps
  name: '@dsh-bridge/dsh-core'
  config:
    strict: true                                  # required with two or more apps
    applications:
      - id: order-desk                            # = system.id in the manifest
        name: Order Desk                          # shown as the card prefix and in the signature "— Order Desk AI secretary"
        namespace: order                          # tools are order_*
        paths: v1
        apiUrlEnv: ORDER_API_URL                  # read on every call
        serviceTokenEnv: ORDER_SERVICE_TOKEN      # never write the token itself in the yml
        manifestUrl: /bridge/v1/manifest          # etag / 304
        generateTools: true                       # generate read tools from the manifest
        agents: [order-assistant]
        delegation: { unattendedPolicy: deny }    # automatic tasks get no business data by default
        bots:
          - { platform: slack, botId: <bot id of the Order Desk Slack App> }
```

   - `manifestFile: pkg:…` only for a package that the DSH profile can resolve. For another repository, use an absolute path, or omit it and keep only `manifestUrl`.
4. Hand-written tools (proposal tools and so on; tools with `access: propose` are not generated) go in `toolModules` of `bridge-tools`; message wording goes in `templateModules` of `bridge-notify`
   (GUIDELINE section c. Read business data only with `kit.requestJson`, and write only as `kit.proposeTool` proposals. Do not touch the business DB or secrets).

## 2. Keep the outbound settings at their closed values (d.8)

The template ships with the following values. **Do not delete them, and do not change how they are written** (`check.mjs` checks the textual form, so keep one value per line and keep the `name:` lines. Rewriting them into the one-line form `config: { … }` fails with `closed_value`).

| Component | Value | Meaning |
|---|---|---|
| IM (dsh-im) | `forwardPluginSources: []` | Do not copy launch replies into the conversation |
| Scheduled runs (dsh-proactive) | `modelTools: reclaim`, `deliveryGuard: required` | The model cannot specify arbitrary destinations; nothing is sent without the guard |
| Automatic tasks (dsh-auto-tasks) | `restrictDelivery: true`, `mail: false` | No fixed delivery targets, no mail |
| bridge-identity / bridge-tools | `groupChat: deny` | Business is not handled in group conversations |
| bridge-notify | `aiReportGuard: screen`, `proactiveDelivery: deny`, `audienceFallback: none`, `audienceText: template` | Scheduled report bodies are checked, business alarms are not sent, no fallback recipients, automatic task reports use fixed wording |

- **Opening a setting is explicit opt-in only**: change that line in the product patch and leave the reason in a comment. For an entry that already exists, only add values (do not create two entries with the same id).
- `install.mjs` rejects fixed delivery targets (`--auto-task-session / --auto-task-bot / --auto-task-target`) (exit 2).

## 3. Other settings

- **AI employee presets**: adapt the template's `business-assistant` to your product, and add a preset of the same shape for each `agent` of the manifest's playbooks. Keep the fixed-rule text of the persona.
  If you use the manual, print the text returned by `helpRules('<ns>_help_search')` (`@dsh-bridge/dsh-core`) with node and **paste it as is** into `prefix`.
- **Link checking**: in bridge-identity, write `linkGuard: { webUrl: <business web app URL of the default app>, webUrls: { <application-id>: <URL> } }` **for every app**.
  The check works only when there is both a URL and `web.routes` in the manifest (rule `link_guard` in `check.mjs`).
- **Two or more apps**: for each non-default app, write `applications.<id>.webUrl` (and `bots`) of `bridge-notify` / `bridge-approvals`, `agents[].application` of `bridge-assistant`,
  `linkGuard.webUrls.<id>`, and delegation for automatic tasks (4 below). If you do not, the app runs empty.
- The template bundle includes long-term memory (bridge-memory), the profile (bridge-persona) and document reading (bridge-reader). If the business system has no matching route, they run with local checks only, with no profile, and doing nothing, respectively.

## 4. Install and run

```sh
node <framework>/profile/scripts/install.mjs --source <product>/dsh-profile --home <isolated home> --profile <name>   # a personal ~/.dsh is rejected
node <framework>/profile/scripts/check.mjs <product>/dsh-profile/cordis.patch.yml                                  # outbound settings, link_guard, placeholders
```

- Run DSH in an isolated home (the command example in GUIDELINE a.4). The `dsh web: …?token=…` that DSH prints is the owner's credential, so do not give it to the browser; only the gateway uses it.
  DSH also reads `.env` in the working directory, so do not start it at the repository root. Do not use the ports of the demo environment or production.
- Secrets (service token, bot credentials, model keys) come from environment variables or a secret store. Have the user enter them.
- DSH version: the framework is tested with the DSH CLI named in `profile/template/package.json` `dshBridge.expectedDsh` (0.2.2-rc.1); `install.mjs`
  warns on another version and uses `DSH_BIN` when it is set. Install that version locally for the product (for example `npm install @deepseek-ai/dsh@<version>`
  in a tools folder, then `DSH_BIN=<folder>/node_modules/@deepseek-ai/dsh/lib/bin.js`). Do not install, upgrade or downgrade the user's global DSH without asking.

## 5. Enable automatic tasks (b.7)

An automatic-task turn has no sender, so by default it cannot read business data (`unattendedPolicy: deny`).

```sh
# use a different delegate for each kind of work (recommended)
node <framework>/profile/scripts/install.mjs --home <home> --auto-task-delegate billing=line:<userId>,ops=line:<userId>,inspector=each
# enable manifest playbooks by id (after DSH has started once and plugin-events has deployed them)
node <framework>/profile/scripts/install.mjs --home <home> --skip-install --enable-auto-tasks pb_<application-id>_<playbook>
node <framework>/profile/scripts/install.mjs --home <home> --auto-task-delegate off    # back to deny
```

- `<class>=<platform>:<userId>`: playbooks of that class run under that employee's delegation. Do not choose a broad role (such as administrator) (`unattendedWarnRoles` can emit a warning).
- `<class>=each`: on each run, the delegation of the person in the triggering event. Requires the business system's `hooks.eventDelegations`. Enabled only when named by id.
- `--auto-task-delegate` applies only to the **default app** (`default: true`, or the only app). For a non-default app, write it by hand in `bridge-tools.applications.<id>` of the product patch,
  run `check.mjs` with `--allow unattendedPolicy`, and leave the reason (which class, entrusted to an employee with which narrow role) in a comment above that line.
- Define the presets for the playbooks' `agent` in the product profile. Only reads and the proposals listed in that playbook's `tools` are allowed.
- Enabling a task needs no restart. Changes to delegation (patch) and plugins need a DSH restart.
