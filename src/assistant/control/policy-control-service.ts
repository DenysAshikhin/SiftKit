import type { AssistantPolicyDto } from '@siftkit/contracts';
import type { AssistantGraph } from '../assistant-graph.js';

/** User-facing policy toggles. Callers gate on `enabled` before invoking, same as the facade did. */
export class PolicyControlService {
  constructor(private readonly graph: AssistantGraph, private readonly ownerId: string) {}

  list(): AssistantPolicyDto[] {
    return this.graph.policies.listPolicies(this.ownerId).map((row) => ({
      id: row.id,
      policyType: row.policy_type,
      topicKey: row.key,
      active: row.enabled,
    }));
  }

  setEnabled(policyId: string, enabled: boolean): boolean {
    const policy = this.graph.policies.getPolicyById(this.ownerId, policyId);
    if (policy === null) return false;
    this.graph.policies.setEnabled(this.ownerId, policy.policy_type, policy.key, enabled);
    return true;
  }

  delete(policyId: string): boolean {
    const policy = this.graph.policies.getPolicyById(this.ownerId, policyId);
    if (policy === null) return false;
    this.graph.policies.deletePolicy(this.ownerId, policy.policy_type, policy.key);
    return true;
  }

  blockTopic(topic: string): void {
    this.graph.policies.upsertPolicy({
      ownerId: this.ownerId,
      policyType: 'never_infer_topic',
      key: topic,
      value: { reason: 'CLI user block' },
      enabled: true,
      source: 'user',
    });
  }
}
