import { inject, Injectable } from '@angular/core';
import type { AgentHandler } from '@axe/application/agent/agent-tool-runner.service';
import { AUTOMATION_SCOPES, type AutomationErrorCode } from '@axe/application/automation/automation-contract';
import { AutomationFacadeService } from '@axe/application/automation/automation-facade.service';
import { AutomationPolicyService } from '@axe/application/automation/automation-policy.service';
import { AgentToolError } from '@axe/core/agent/agent-error';
import type { AgentErrorCode } from '@axe/core/agent/agent-protocol';
import { FORK_AGENT_TOOLS } from '@axe/core/agent/fork-agent-tools';

/** How each refusal of the fork's facade reads to the AI link. */
const ERROR_CODES: Readonly<Record<AutomationErrorCode, AgentErrorCode>> = {
  NOT_READY: 'failed',
  NOT_FOUND: 'not_found',
  NOT_VISIBLE: 'not_found',
  FORBIDDEN: 'not_allowed',
  LOCKED: 'not_allowed',
  INVALID_ARGUMENT: 'invalid_input',
  CONFLICT: 'failed',
  TIMEOUT: 'timeout',
  INTERNAL_ERROR: 'failed',
};

/**
 * Runs the fork's own tools for the AI link, each through the fork's automation facade under the
 * same name, so the facade's checks of who may do what, its rate limit and its one write at a time
 * hold for the link as they hold for tools/mcp-server.
 *
 * The link's runner has already weighed the call against what the person at the seat lets the AI
 * do, so the facade is given every scope; a seat that lets the AI read only never reaches a tool
 * that writes.
 */
@Injectable({ providedIn: 'root' })
export class ForkAutomationTools {
  private readonly facade = inject(AutomationFacadeService);
  private readonly policy = inject(AutomationPolicyService);

  readonly handlers: Readonly<Record<string, AgentHandler>> = Object.fromEntries(
    FORK_AGENT_TOOLS.map((tool) => [tool.name, (args: Readonly<Record<string, unknown>>) => this.run(tool.name, args)])
  );

  private async run(command: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.ready();
    const result = await this.facade.invoke({
      sessionId: this.policy.sessionId(),
      requestId: crypto.randomUUID(),
      command,
      arguments: { ...args },
    });
    if (result.ok) return result.data;
    throw new AgentToolError(ERROR_CODES[result.error.code] ?? 'failed', result.error.message);
  }

  /** Opens the facade to the link, unless a person stopped AI control at this seat. */
  private ready(): void {
    if (this.policy.stoppedByUser()) {
      throw new AgentToolError('not_allowed', 'The person at this seat stopped AI control in its AI control panel.');
    }
    if (!this.policy.enabled()) this.policy.enable();
    for (const scope of AUTOMATION_SCOPES) {
      if (!this.policy.scopes().includes(scope)) this.policy.setScope(scope, true);
    }
  }
}
