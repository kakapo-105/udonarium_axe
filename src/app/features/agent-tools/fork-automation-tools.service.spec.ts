import { TestBed } from '@angular/core/testing';
import { AUTOMATION_COMMANDS, AUTOMATION_SCOPES } from '@axe/application/automation/automation-contract';
import { AutomationFacadeService } from '@axe/application/automation/automation-facade.service';
import { AutomationPolicyService } from '@axe/application/automation/automation-policy.service';
import { AgentToolError } from '@axe/core/agent/agent-error';
import { AGENT_TOOLS } from '@axe/core/agent/agent-tools';
import { FORK_AGENT_TOOLS, FORK_BRIDGE_COMMANDS, FORK_BRIDGE_TOOL_NAME } from '@axe/core/agent/fork-agent-tools';
import { ForkAutomationTools } from '@axe/features/agent-tools/fork-automation-tools.service';
import { TEST_PROVIDERS } from '@axe/testing/test-providers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('ForkAutomationTools', () => {
  const invoke = vi.fn();
  let tools: ForkAutomationTools;
  let policy: AutomationPolicyService;

  beforeEach(() => {
    invoke.mockReset();
    TestBed.configureTestingModule({
      providers: [...TEST_PROVIDERS, { provide: AutomationFacadeService, useValue: { invoke } }],
    });
    tools = TestBed.inject(ForkAutomationTools);
    policy = TestBed.inject(AutomationPolicyService);
  });

  it('runs every fork tool, each one a command of the facade, and none named as an upstream tool', () => {
    const names = FORK_AGENT_TOOLS.map((tool) => tool.name);
    expect(Object.keys(tools.handlers).sort()).toEqual([...names].sort());
    for (const name of names.filter((each) => each !== FORK_BRIDGE_TOOL_NAME)) {
      expect(AUTOMATION_COMMANDS as readonly string[]).toContain(name);
    }
    for (const command of FORK_BRIDGE_COMMANDS) expect(AUTOMATION_COMMANDS as readonly string[]).toContain(command);
    expect(new Set(AGENT_TOOLS.map((tool) => tool.name)).size).toBe(AGENT_TOOLS.length);
  });

  it('leaves the session and the request to the link, not to the AI', () => {
    for (const tool of FORK_AGENT_TOOLS) {
      expect(Object.keys(tool.input.properties)).not.toContain('sessionId');
      expect(Object.keys(tool.input.properties)).not.toContain('requestId');
    }
  });

  it('hands a call to the facade under its own name, in the session it opens with every scope', async () => {
    invoke.mockResolvedValue({ ok: true, data: { tables: [] } });
    await expect(tools.handlers['table_list']({}, { signal: new AbortController().signal })).resolves.toEqual({
      tables: [],
    });
    expect(policy.enabled()).toBe(true);
    expect([...policy.scopes()].sort()).toEqual([...AUTOMATION_SCOPES].sort());
    const [request] = invoke.mock.calls[0];
    expect(request).toMatchObject({ sessionId: policy.sessionId(), command: 'table_list', arguments: {} });
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps the session it opened from one call to the next', async () => {
    invoke.mockResolvedValue({ ok: true, data: null });
    const signal = new AbortController().signal;
    await tools.handlers['table_list']({}, { signal });
    const first = policy.sessionId();
    await tools.handlers['range_list']({}, { signal });
    expect(policy.sessionId()).toBe(first);
    expect(invoke.mock.calls[1][0].requestId).not.toBe(invoke.mock.calls[0][0].requestId);
  });

  it('tells a refusal of the facade as the link tells its own', async () => {
    invoke.mockResolvedValue({ ok: false, error: { code: 'FORBIDDEN', message: 'Game master only.' } });
    const call = tools.handlers['piece_conceal']({ identifiers: ['x'] }, { signal: new AbortController().signal });
    await expect(call).rejects.toBeInstanceOf(AgentToolError);
    await expect(call).rejects.toMatchObject({ code: 'not_allowed', message: 'Game master only.' });
  });

  it('runs nothing at a seat whose person stopped AI control', async () => {
    policy.stopByUser();
    await expect(tools.handlers['table_list']({}, { signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'not_allowed',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('runs a command the bridge prepared, its arguments read from the JSON it was given', async () => {
    invoke.mockResolvedValue({ ok: true, data: { staged: true } });
    const payload = JSON.stringify({ bgm: 'abc', audios: [{ identifier: 'abc', data: 'AAAA' }] });
    await expect(
      tools.handlers[FORK_BRIDGE_TOOL_NAME]({ command: 'vn_stage', payload }, { signal: new AbortController().signal })
    ).resolves.toEqual({ staged: true });
    expect(invoke.mock.calls[0][0]).toMatchObject({ command: 'vn_stage', arguments: JSON.parse(payload) });
  });

  it('refuses a prepared command whose arguments are not a JSON object', async () => {
    const signal = new AbortController().signal;
    for (const payload of ['{', '[1]', 'null']) {
      await expect(
        tools.handlers[FORK_BRIDGE_TOOL_NAME]({ command: 'vn_stage', payload }, { signal })
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it('marks what is said while a call of the link runs as the AI’s, and nothing after it', async () => {
    const during: boolean[] = [];
    invoke.mockImplementation(async () => {
      during.push(policy.viaAiLink);
      return { ok: true, data: null };
    });
    await tools.handlers['table_list']({}, { signal: new AbortController().signal });
    expect(during).toEqual([true]);
    expect(policy.viaAiLink).toBe(false);
  });
});
