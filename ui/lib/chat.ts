import type { ChatMessage, ChatProposal } from "../../src/core/types.ts";

/** POST responses and SSE replays may overlap or arrive out of order. */
export function mergeChatMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  return [...new Map([...current, ...incoming].map((m) => [m.id, m])).values()].sort((a, b) => a.id - b.id);
}

export function chatProposals(messages: ChatMessage[]): ChatProposal[] {
  const proposals = new Map<string, ChatProposal>();
  for (const message of messages) {
    const proposal = message.outcome?.proposal;
    if (proposal) proposals.set(proposal.id, proposal);
  }
  return [...proposals.values()];
}
