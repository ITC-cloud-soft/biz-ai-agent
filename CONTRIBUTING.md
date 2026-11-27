# Contributing to biz-ai-agent

**English** · [日本語](#日本語)

Thank you for looking. Questions, bug reports, documentation fixes, new example agents and reports from building an agent with
the `agent-builder` skill are all welcome.

## Where to start

| you want to | go to |
|---|---|
| ask how to do something, or show the agent you built | [Discussions](https://github.com/ITC-cloud-soft/biz-ai-agent/discussions) |
| report a bug | [a bug report](https://github.com/ITC-cloud-soft/biz-ai-agent/issues/new?template=bug.yml) |
| report where the `agent-builder` skill was wrong, missing or out of order | [a skill report](https://github.com/ITC-cloud-soft/biz-ai-agent/issues/new?template=skill.yml) |
| pick something small to fix | issues labelled [`good first issue`](https://github.com/ITC-cloud-soft/biz-ai-agent/labels/good%20first%20issue) |
| report a vulnerability | **not an issue** — see [SECURITY.md](SECURITY.md) |

## Set up

Node.js 24.9+ (the pinned DSH CLI needs it; `npm install` / `npm test` alone run on 22.19+), npm, and pnpm on PATH for the
end-to-end run. No database, no API key, no chat account.

```sh
git clone https://github.com/ITC-cloud-soft/biz-ai-agent.git && cd biz-ai-agent
npm install
npm run vendor:install      # once
npm test                    # about 900 tests
npm run e2e                 # on a real DSH with a mock model and a mock LINE: 15 / 15 PASS
```

No local setup at all: open the repository in GitHub Codespaces (the dev container installs Node 24 and pnpm).

## Two kinds of code in this repository

| part | where | how to change it |
|---|---|---|
| **the agent layer** (this repository's own) | `packages/knowledge`, `packages/graph`, `packages/agent-settings`, `plugins/knowledge`, `plugins/graph`, `skills/agent-builder`, `examples/equipment-loans`, `examples/expense-claims`, `examples/leave-requests-knowledge`, `e2e/` | a pull request here |
| **the Biz Assistant Framework** (copied in by `scripts/sync-framework.mjs`, listed in [`framework.sync.json`](framework.sync.json)) | the other packages, plugins, `profile`, `vendor`, the framework's examples and docs | open the issue or PR on [biz-ai](https://github.com/ITC-cloud-soft/biz-ai); a change made only here is overwritten by the next sync |

## The rules every change keeps

1. **The AI employee reads and proposes; people decide.** It never confirms, approves or pays, and amounts are decided by people.
   Enforced in code and configuration, not in prompts.
2. **Permissions first.** Every search and every graph answer is filtered by the asker's rights *before* it is ranked.
3. **The business system decides who is told**, with the same rule as its web screens.
4. **No personal data in events and notifications** — IDs, numbers, dates and states only.

## Pull requests

- Keep them small and say *why*. Add or update tests and evals; `npm test` must pass, and `npm run e2e` for anything that touches
  DSH, the gateway or chat.
- Fictional data only in tests, `knowledge/*.md` and examples.
- Code that an AI coding tool helped write is welcome — run it and check it yourself first. A new example built with the
  `agent-builder` skill is most useful with its `SKILL_REPORT.md` (see [`examples/expense-claims`](examples/expense-claims)).
- Contributions are accepted under the repository's license, [Apache-2.0](LICENSE).

---

## 日本語

質問、バグ報告、ドキュメントの修正、新しい見本エージェント、`agent-builder` skill で作ってみた報告、どれも歓迎します。

| したいこと | 行き先 |
|---|---|
| 使い方の質問、作ったエージェントの紹介 | [Discussions](https://github.com/ITC-cloud-soft/biz-ai-agent/discussions) |
| バグの報告 | [バグ報告](https://github.com/ITC-cloud-soft/biz-ai-agent/issues/new?template=bug.yml) |
| `agent-builder` skill の間違い・抜け・順番の問題 | [skill の報告](https://github.com/ITC-cloud-soft/biz-ai-agent/issues/new?template=skill.yml) |
| 小さなところから手伝いたい | [`good first issue`](https://github.com/ITC-cloud-soft/biz-ai-agent/labels/good%20first%20issue) のついた issue |
| 脆弱性の報告 | **issue には書かないでください。** [SECURITY.md](SECURITY.md) を見てください |

準備のコマンドは英語版と同じです。GitHub Codespaces で開けば、手元の準備は要りません。

**変更の場所：** エージェント層（knowledge・graph・agent-settings・agent-builder skill・この repo の見本）はここに PR を出してください。
それ以外（[`framework.sync.json`](framework.sync.json) に載っている部分）は [biz-ai](https://github.com/ITC-cloud-soft/biz-ai) 側で直します。ここだけで直しても、次の同期で上書きされます。

**どの変更も守る約束：** AI は読んで提案するだけで、確定・承認・支払いはしない（金額は人が決める）。検索とグラフの答えは、並べる前に聞いた人の権限で絞る。
誰に知らせるかは業務システムが決める。イベントと通知に個人情報を入れない。

**プルリクエスト：** 小さく、理由を書いてください。`npm test` が通ること（DSH・ゲートウェイ・チャットに触れる変更は `npm run e2e` も）。
テストや見本は架空のデータだけで。AI コーディングツールで書いたコードも歓迎です（自分で動かして確かめてから）。ライセンスは [Apache-2.0](LICENSE) です。
