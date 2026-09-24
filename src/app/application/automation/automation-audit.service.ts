import { Injectable, signal } from '@angular/core';
export interface AutomationAuditEntry {
  requestId: string;
  command: string;
  at: string;
  outcome: string;
}
@Injectable({ providedIn: 'root' })
export class AutomationAuditService {
  private readonly held = signal<readonly AutomationAuditEntry[]>([]);
  readonly entries = this.held.asReadonly();
  add(entry: AutomationAuditEntry): void {
    this.held.update((rows) => [entry, ...rows].slice(0, 100));
  }
}
