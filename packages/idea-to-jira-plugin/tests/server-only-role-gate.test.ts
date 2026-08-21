import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const packageRoot = process.cwd();
const repositoryRoot = resolve(packageRoot, "../..");

function readRepositoryFile(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

test("model policy trusts server admission and contains no role lookup or denial path", () => {
  const policy = readRepositoryFile("data/workspace/AGENTS.md");
  assert.match(policy, /Access control for ordinary conversation is enforced exclusively by the\nserver before model execution\./);
  assert.match(policy, /If a free-form message reaches the model, the\nserver has already admitted that turn\./);
  assert.match(policy, /Role and access state are not model\ninputs and must never be queried or evaluated by the model\./);

  for (const forbidden of [
    "У вас пока нет роли Creator",
    "Запрос на роль Creator уже отправлен",
    "Роль Creator временно приостановлена",
    "Доступ к сервису ограничен",
    "Не удалось проверить доступ",
    "A role is authoritative only when supplied",
    "request workflow access when explicitly requested",
  ]) {
    assert.equal(policy.includes(forbidden), false, `model policy contains server-only access text: ${forbidden}`);
  }
});

test("plugin registers channel-dispatch and agent-run gates for free-form admission", () => {
  const indexSource = readRepositoryFile("packages/idea-to-jira-plugin/src/index.ts");
  const requesterSource = readRepositoryFile("packages/idea-to-jira-plugin/src/runtime/requester-context.ts");
  const roleSource = readRepositoryFile("packages/idea-to-jira-plugin/src/runtime/conversation-role-gate.ts");
  const registeredGateHooks = [...indexSource.matchAll(/api\.on\("(before_dispatch|before_agent_[^"]+)"/g)]
    .map((match) => match[1]);

  assert.deepEqual(registeredGateHooks, [
    "before_dispatch",
    "before_agent_run",
    "before_dispatch",
    "before_agent_run",
  ]);
  assert.equal(indexSource.includes("before_agent_reply"), false);
  assert.equal(requesterSource.includes("before_agent_reply"), false);
  assert.equal(roleSource.includes("before_agent_reply"), false);
});
