import { applyMutation, effectiveState, type Draft, type MailMutation, type ThreadState } from "./effective-state";

export type MutationSender = (threadId: string, mutation: MailMutation) => Promise<void>;
interface PendingOperation { mutation: MailMutation; resolve: () => void; reject: (error: unknown) => void }
interface ThreadEntry { confirmed: ThreadState; pending: PendingOperation[]; processing: boolean }

/** Per-thread writes are sent in order, while every queued mutation is visible immediately. */
export class OptimisticMailClient {
  private readonly threads = new Map<string, ThreadEntry>();
  private readonly listeners = new Set<() => void>();

  constructor(initialThreads: readonly ThreadState[], private readonly send: MutationSender) {
    for (const thread of initialThreads) {
      if (this.threads.has(thread.id)) throw new Error(`Duplicate thread: ${thread.id}`);
      this.threads.set(thread.id, { confirmed: structuredClone(thread), pending: [], processing: false });
    }
  }

  getThread(threadId: string): ThreadState {
    const entry = this.requireThread(threadId);
    return structuredClone(effectiveState(entry.confirmed, entry.pending.map((operation) => operation.mutation)));
  }

  getPendingCount(threadId: string): number { return this.requireThread(threadId).pending.length; }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  archive(threadId: string): Promise<void> { return this.enqueue(threadId, { type: "archive" }); }
  addLabel(threadId: string, label: string): Promise<void> { return this.enqueue(threadId, { type: "addLabel", label }); }
  markRead(threadId: string, read = true): Promise<void> { return this.enqueue(threadId, { type: "markRead", read }); }
  createDraft(threadId: string, draft: Draft): Promise<void> { return this.enqueue(threadId, { type: "createDraft", draft: { ...draft } }); }

  private requireThread(threadId: string): ThreadEntry {
    const entry = this.threads.get(threadId);
    if (!entry) throw new Error(`Unknown thread: ${threadId}`);
    return entry;
  }
  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); }
      catch (error) { console.error("Optimistic mail listener failed", error); }
    }
  }
  private enqueue(threadId: string, mutation: MailMutation): Promise<void> {
    const entry = this.requireThread(threadId);
    const result = new Promise<void>((resolve, reject) => { entry.pending.push({ mutation, resolve, reject }); });
    this.notify();
    void this.process(threadId, entry);
    return result;
  }
  private async process(threadId: string, entry: ThreadEntry): Promise<void> {
    if (entry.processing) return;
    entry.processing = true;
    while (entry.pending.length > 0) {
      const operation = entry.pending[0];
      try {
        await this.send(threadId, operation.mutation);
        entry.confirmed = applyMutation(entry.confirmed, operation.mutation);
        entry.pending.shift();
        this.notify();
        operation.resolve();
      } catch (error) {
        entry.pending.shift();
        this.notify();
        operation.reject(error);
      }
    }
    entry.processing = false;
  }
}
