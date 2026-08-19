// Control-plane activities on the agent-tasks queue (09 §2). T31 scaffold:
// one trivial activity proving the dispatch path; the real activity set
// (working-set builder, model call, action executors) lands with T32.
export async function echoActivity(note: string): Promise<string> {
  return `echo:${note}`;
}
