// Finds loops in "blocks" relations, so a person can see which tasks block
// each other in a circle and remove one link. Used by
// `greatstone-db.ts blocking-cycles` (see scripts/greatstone-blocking-cycles.sh).

/**
 * Groups of tasks that block each other in a loop, per company.
 * @param {Array<{ id: string, companyId: string, blockerIssueId: string, blockedIssueId: string }>} edges
 * @returns {Array<{ companyId: string, issueIds: string[], edges: typeof edges }>}
 */
export function findBlockingCycles(edges) {
  const byCompany = new Map();
  for (const edge of edges) {
    const list = byCompany.get(edge.companyId) ?? [];
    list.push(edge);
    byCompany.set(edge.companyId, list);
  }

  const cycles = [];
  for (const [companyId, companyEdges] of byCompany) {
    const adjacency = new Map();
    for (const edge of companyEdges) {
      const next = adjacency.get(edge.blockerIssueId) ?? [];
      next.push(edge.blockedIssueId);
      adjacency.set(edge.blockerIssueId, next);
      if (!adjacency.has(edge.blockedIssueId)) adjacency.set(edge.blockedIssueId, []);
    }
    for (const group of stronglyConnected(adjacency)) {
      if (group.length < 2) continue;
      const members = new Set(group);
      cycles.push({
        companyId,
        issueIds: [...group].sort(),
        edges: companyEdges.filter(
          (edge) => members.has(edge.blockerIssueId) && members.has(edge.blockedIssueId),
        ),
      });
    }
  }
  return cycles;
}

// Tarjan's algorithm, iterative so a long chain of tasks cannot overflow the stack.
function stronglyConnected(adjacency) {
  let index = 0;
  const indexOf = new Map();
  const lowOf = new Map();
  const onStack = new Set();
  const stack = [];
  const groups = [];

  for (const start of adjacency.keys()) {
    if (indexOf.has(start)) continue;
    const work = [{ node: start, next: 0 }];
    indexOf.set(start, index);
    lowOf.set(start, index);
    index += 1;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const neighbours = adjacency.get(frame.node) ?? [];
      if (frame.next < neighbours.length) {
        const neighbour = neighbours[frame.next];
        frame.next += 1;
        if (!indexOf.has(neighbour)) {
          indexOf.set(neighbour, index);
          lowOf.set(neighbour, index);
          index += 1;
          stack.push(neighbour);
          onStack.add(neighbour);
          work.push({ node: neighbour, next: 0 });
        } else if (onStack.has(neighbour)) {
          lowOf.set(frame.node, Math.min(lowOf.get(frame.node), indexOf.get(neighbour)));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].node;
        lowOf.set(parent, Math.min(lowOf.get(parent), lowOf.get(frame.node)));
      }
      if (lowOf.get(frame.node) === indexOf.get(frame.node)) {
        const group = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          group.push(member);
        } while (member !== frame.node);
        groups.push(group);
      }
    }
  }
  return groups;
}
