# Repository Guidelines

## Project Structure & Module Organization
- `src/` – MCP server code (tools, storage, adapters).
- `tests/` – unit/integration tests mirroring `src/` (e.g., `tests/tools/history.test.ts`).
- `dist/` – build output (bundled JS). Do not edit.
- `scripts/` – local dev/CI helpers.
- `docs/` and `assets/` – documentation, diagrams, and non-code artifacts.

## Build, Test, and Development Commands
- Package manager: pnpm (recommended). Use the commands below.
- Install: `pnpm install`.
- Develop (stdio server): `pnpm start` – launches the MCP over stdio.
- Build: `pnpm build` – outputs to `dist/`.
- Test: `pnpm test` – run all tests; `pnpm test:watch` for TDD.
- Lint/Format: `pnpm lint` and `pnpm format` to check/fix style.

## Coding Style & Naming Conventions
- Language: TypeScript for new code; place files in `src/`.
- Formatting: Prettier (2 spaces, 100-col soft limit). Run `npm run format`.
- Linting: ESLint with TypeScript plugin; fix or justify all errors.
- Naming: `kebab-case` files (`message-store.ts`), `camelCase` functions/vars, `PascalCase` classes/types.

## Testing Guidelines
- Framework: Vitest or Jest; keep tests deterministic and offline.
- Filenames: unit `*.test.ts`, integration `*.spec.ts`.
- Coverage: target ≥ 80% lines/branches for changed areas. Generate via `npm test -- --coverage`.

## Commit & Pull Request Guidelines
- Commits: Conventional Commits, e.g., `feat: add history.fetch tool` or `fix(storage): handle empty summary`.
- PRs: concise description, linked issues (`Closes #123`), tests updated/added, docs touched when behavior changes. Keep scope focused.

## Security & Configuration Tips
- Never commit secrets. Provide `.env.example` and read via config loader.
- Keep dependencies minimal and audited (`pnpm audit`).
- Avoid network calls in tools unless required; prefer local storage.

## Alternative Package Managers
- npm: `npm ci` (or `npm install`), `npm run start`, `npm run build`, `npm test`, `npm run test:watch`, `npm run lint`, `npm run format`, `npm audit`.
- yarn: `yarn install`, `yarn start`, `yarn build`, `yarn test`, `yarn test --watch`, `yarn lint`, `yarn format`, `yarn audit` (Classic) or `yarn npm audit` (Berry).

## CI Example (pnpm)
GitHub Actions (`.github/workflows/ci.yml`):
```yaml
name: ci
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - uses: pnpm/action-setup@v2
        with: { version: 9 }
      - name: Install
        run: pnpm install --frozen-lockfile
      - name: Lint
        run: pnpm lint
      - name: Build
        run: pnpm build
      - name: Test
        run: pnpm test -- --coverage
```

## Recommended package.json scripts (pnpm)
```json
{
  "scripts": {
    "dev": "node dist/index.js --stdio",
    "start": "node dist/index.js --stdio",
    "build": "esbuild src/index.ts --bundle --platform=node --outfile=dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint --max-warnings=0 .",
    "format": "prettier -w .",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

## Agent-Specific Instructions
- Follow this guide and keep changes minimal and localized.
- Update tests and docs alongside code.
- Respect AGENTS.md across the repo; do not rename modules without justification.

## Must Use this MCP to Manage Dialogs
```text
      - MCP 工具名：history（以下为工具名称）
        - history_list_dialogs({projectRoot}) -> {dialogs}
        - history_get_summary({projectRoot, dialog}) -> {summary|null}
        - history_set_summary({projectRoot, dialog, summary}) -> {ok:true}
        - history_fetch({projectRoot, dialog, recentTurns?}) -> {messages:[{role,text,ts}]}
        - history_save({projectRoot, dialog, entry:{role:'user'|'assistant',text,ts?}}) -> {ok:true}
        - history_clear({projectRoot, dialog}) -> {ok:true}

      - 约定
        - projectRoot=<ABS_PROJECT_ROOT>
        - 工具返回在第一个 text 内容项里，需 JSON.parse(content[0].text)

      - 会话初始化（只做一次）
        - 先 history_list_dialogs 选定 dialog
        - 然后 history_get_summary + history_fetch(6)

      - 保存策略（低频、可口头修改阈值）
        - 仅以下情况调用保存，否则不调用任何工具：
          - 重要回答：答案含“决策/约束/TODO/ISSUE/引用”等小节标题或明显结构化信号 → 立即保存
          - 回合上限 K：每满 K 个助手回合保存一次（默认 K=5）
          - 字节上限 B：累计未保存文本 ≥ B 立即保存（默认 B=48KB）
          - 手动：用户说“保存/同步”时立即保存
        - 执行保存时：
          - 依次调用 history_save 写入自上次保存以来的全部消息（批量，按时间顺序）
          - 摘要节流：仅在“重要保存”或每满 M 次保存后调用一次 history_set_summary（默认 M=3；~700 tokens，按决策/约束/TODO/ISSUE/事实/引用组织）
        - 任何工具失败：不中断对话，直接跳过保存本次
```